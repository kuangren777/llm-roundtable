"""add mode and llm_configs to discussions

Revision ID: b2a3c4d5e6f7
Revises: 8991597c1c94
Create Date: 2026-02-14 10:00:00.000000
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


revision: str = 'b2a3c4d5e6f7'
down_revision: Union[str, None] = '8991597c1c94'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('discussions', sa.Column(
        'mode',
        sa.Enum('AUTO', 'DEBATE', 'BRAINSTORM', 'SEQUENTIAL', 'CUSTOM', name='discussionmode'),
        nullable=False,
        server_default='AUTO',
    ))
    op.add_column('discussions', sa.Column(
        'llm_configs',
        sa.JSON(),
        nullable=False,
        server_default='[]',
    ))


def downgrade() -> None:
    op.drop_column('discussions', 'llm_configs')
    op.drop_column('discussions', 'mode')
