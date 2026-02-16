"""add status and metadata columns to discussion_materials

Revision ID: g7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-02-16
"""
from alembic import op
import sqlalchemy as sa

revision = "g7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("discussion_materials") as batch_op:
        batch_op.add_column(sa.Column("status", sa.String(20), nullable=False, server_default="ready"))
        batch_op.add_column(sa.Column("meta_info", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("discussion_materials") as batch_op:
        batch_op.drop_column("meta_info")
        batch_op.drop_column("status")
