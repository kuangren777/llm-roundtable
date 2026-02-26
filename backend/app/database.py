from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text
import secrets
import string
from .config import get_settings
from .services.security import hash_password


class Base(DeclarativeBase):
    pass


engine = create_async_engine(get_settings().database_url, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
CODE_ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 16


async def get_db() -> AsyncSession:
    async with async_session() as session:
        yield session


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Lightweight runtime migration for SQLite dev DBs.
        # create_all() does not add missing columns to existing tables.
        dialect = conn.dialect.name
        if dialect == "sqlite":
            table_info = await conn.execute(text("PRAGMA table_info('discussions')"))
            columns = {row[1] for row in table_info.fetchall()}
            if "chat_code" not in columns:
                await conn.execute(text("ALTER TABLE discussions ADD COLUMN chat_code VARCHAR(16)"))
            if "owner_user_id" not in columns:
                await conn.execute(text("ALTER TABLE discussions ADD COLUMN owner_user_id INTEGER"))

            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_discussions_chat_code ON discussions (chat_code)"))
            await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discussions_owner_user_id ON discussions (owner_user_id)"))
            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users (email)"))
            await conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_discussion_shares_share_code ON discussion_shares (share_code)"))
            await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_discussion_shares_discussion_id ON discussion_shares (discussion_id)"))

    # Seed admin account and backfill owner/chat_code for legacy discussions.
    settings = get_settings()
    async with async_session() as session:
        admin = (await session.execute(text("SELECT id FROM users ORDER BY id ASC LIMIT 1"))).first()
        if admin is None:
            email = settings.seed_admin_email.strip().lower()
            pwd_hash = hash_password(settings.seed_admin_password)
            await session.execute(
                text(
                    "INSERT INTO users (email, password_hash, is_active, is_admin, created_at, updated_at) "
                    "VALUES (:email, :password_hash, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ),
                {"email": email, "password_hash": pwd_hash},
            )
            await session.commit()
            admin = (await session.execute(text("SELECT id FROM users ORDER BY id ASC LIMIT 1"))).first()

        admin_id = int(admin[0])

        rows = await session.execute(text("SELECT id, chat_code, owner_user_id FROM discussions"))
        updates = []
        for disc_id, chat_code, owner_user_id in rows.fetchall():
            new_code = chat_code
            if not new_code:
                # Retry few times on accidental collision.
                for _ in range(5):
                    candidate = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
                    exists = await session.execute(
                        text("SELECT id FROM discussions WHERE chat_code = :code LIMIT 1"),
                        {"code": candidate},
                    )
                    if exists.first() is None:
                        new_code = candidate
                        break
            new_owner = owner_user_id if owner_user_id else admin_id
            if new_code != chat_code or new_owner != owner_user_id:
                updates.append((disc_id, new_code, new_owner))

        for disc_id, code, owner in updates:
            await session.execute(
                text(
                    "UPDATE discussions "
                    "SET chat_code = :code, owner_user_id = :owner "
                    "WHERE id = :id"
                ),
                {"id": disc_id, "code": code, "owner": owner},
            )
        if updates:
            await session.commit()
