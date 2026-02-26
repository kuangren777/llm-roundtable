"""add users, discussion chat code ownership, and share links

Revision ID: j1e2f3a4b5c6
Revises: i9d0e1f2a3b4
Create Date: 2026-02-26 01:20:00.000000
"""

from typing import Sequence, Union
import secrets
import string
import hashlib
import base64

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "j1e2f3a4b5c6"
down_revision: Union[str, None] = "i9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


CODE_ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 16
PBKDF2_ITERATIONS = 390000


def _rand_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    salt_b64 = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    digest_b64 = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_b64}${digest_b64}"


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.add_column("discussions", sa.Column("chat_code", sa.String(length=16), nullable=True))
    op.add_column("discussions", sa.Column("owner_user_id", sa.Integer(), nullable=True))
    op.create_index("ix_discussions_chat_code", "discussions", ["chat_code"], unique=True)
    op.create_index("ix_discussions_owner_user_id", "discussions", ["owner_user_id"], unique=False)
    op.create_foreign_key(
        "fk_discussions_owner_user_id_users",
        "discussions",
        "users",
        ["owner_user_id"],
        ["id"],
    )

    op.create_table(
        "discussion_shares",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("discussion_id", sa.Integer(), nullable=False),
        sa.Column("share_code", sa.String(length=16), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_by_user_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["discussion_id"], ["discussions.id"]),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"]),
    )
    op.create_index("ix_discussion_shares_discussion_id", "discussion_shares", ["discussion_id"], unique=False)
    op.create_index("ix_discussion_shares_share_code", "discussion_shares", ["share_code"], unique=True)
    op.create_index("ix_discussion_shares_created_by_user_id", "discussion_shares", ["created_by_user_id"], unique=False)

    bind = op.get_bind()
    # Seed a bootstrap admin account for legacy data ownership migration.
    bind.execute(
        sa.text(
            "INSERT INTO users (email, password_hash, is_active, is_admin, created_at, updated_at) "
            "VALUES (:email, :password_hash, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ),
        {
            "email": "admin@example.com",
            "password_hash": _hash_password("ChangeMe123!"),
        },
    )
    admin_id = bind.execute(sa.text("SELECT id FROM users ORDER BY id ASC LIMIT 1")).scalar_one()

    rows = bind.execute(sa.text("SELECT id FROM discussions")).fetchall()
    used_codes = set()
    for row in rows:
        disc_id = int(row[0])
        code = _rand_code()
        while code in used_codes:
            code = _rand_code()
        used_codes.add(code)
        bind.execute(
            sa.text(
                "UPDATE discussions SET chat_code = :code, owner_user_id = :owner WHERE id = :id"
            ),
            {"id": disc_id, "code": code, "owner": admin_id},
        )


def downgrade() -> None:
    op.drop_index("ix_discussion_shares_created_by_user_id", table_name="discussion_shares")
    op.drop_index("ix_discussion_shares_share_code", table_name="discussion_shares")
    op.drop_index("ix_discussion_shares_discussion_id", table_name="discussion_shares")
    op.drop_table("discussion_shares")

    op.drop_constraint("fk_discussions_owner_user_id_users", "discussions", type_="foreignkey")
    op.drop_index("ix_discussions_owner_user_id", table_name="discussions")
    op.drop_index("ix_discussions_chat_code", table_name="discussions")
    op.drop_column("discussions", "owner_user_id")
    op.drop_column("discussions", "chat_code")

    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
