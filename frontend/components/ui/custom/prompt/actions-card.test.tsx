/** "ACTIONS TAKEN" card + reference chips in the shared renderer (owner 2026-10-08). */
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from './markdown-content';

const ANSWER = `One heads-up: brief serving blip.

ACTIONS TAKEN

- goal_create → goal 534c37aa — "node-a 64K serving deploy + validation"
- todo_create ×3 → todos 536d5d52, 23014278, 63a8404a — restart / gateway PR / validate+bench
- start_coding_session → receipt b3649334, session fbb5c9ca — lane spawned
- save_supervisor_state — dispatch ledger + notes updated
`;

const html = (md: string) => renderToStaticMarkup(<MarkdownContent>{md}</MarkdownContent>);

describe('actions card', () => {
  it('groups the marker + list into ONE card with a row per action and the tool as a label', () => {
    const out = html(ANSWER);
    expect(out.match(/data-actions-taken/g)).toHaveLength(1);
    expect(out).toContain('Actions taken');
    expect(out).not.toContain('ACTIONS TAKEN');
    expect(out.match(/data-action-item/g)).toHaveLength(4);
    expect(out).toContain('data-action-tool="true">goal_create</span>');
    expect(out).toContain('data-action-tool="true">todo_create ×3</span>');
    expect(out).toContain('data-action-tool="true">save_supervisor_state</span>');
    expect(out).toContain('One heads-up: brief serving blip.');
  });

  it('renders every id the noun names as a chip', () => {
    const out = html(ANSWER);
    expect(out.match(/data-entity-ref="todo"/g)).toHaveLength(3);
    expect(out).toContain('data-entity-ref="session"');
    expect(out).toContain('data-entity-ref="receipt"');
    expect(out).toContain('data-entity-ref="goal"');
  });

  it('leaves an ordinary list and a list without the marker alone', () => {
    expect(html('- goal_create → goal x\n')).not.toContain('data-actions-taken');
    expect(html(ANSWER)).toContain('data-actions-taken');
  });
});
