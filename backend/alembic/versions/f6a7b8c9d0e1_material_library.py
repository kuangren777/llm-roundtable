"""make discussion_materials.discussion_id nullable for library items

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-02-16
"""
from alembic import op
import sqlalchemy as sa

revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite requires batch mode for ALTER COLUMN
    with op.batch_alter_table("discussion_materials") as batch_op:
        batch_op.alter_column("discussion_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    # Delete library items (NULL discussion_id) before making column NOT NULL
    op.execute("DELETE FROM discussion_materials WHERE discussion_id IS NULL")
    with op.batch_alter_table("discussion_materials") as batch_op:
        batch_op.alter_column("discussion_id", existing_type=sa.Integer(), nullable=False)
