"""add title to discussions

Revision ID: c3d4e5f6a7b8
Revises: b2a3c4d5e6f7
Create Date: 2026-02-14 18:00:00.000000
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b2a3c4d5e6f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('discussions', sa.Column('title', sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_column('discussions', 'title')
