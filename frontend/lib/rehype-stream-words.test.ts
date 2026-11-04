import { describe, expect, it } from 'vitest';
import { rehypeStreamWords, splitWords } from './rehype-stream-words';

describe('rehype-stream-words', () => {
  it('splits text into word spans and keeps whitespace as text', () => {
    const nodes = splitWords('Heat pump  wins') as any[];
    expect(nodes.map((n) => n.type === 'text' ? `[${n.value}]` : n.children[0].value)).toEqual(['Heat', '[ ]', 'pump', '[  ]', 'wins']);
    expect(nodes[0].properties.className).toEqual(['dg-word']);
  });

  it('wraps prose but never code', () => {
    const tree: any = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'a b' }] },
        { type: 'element', tagName: 'pre', children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: 'x y' }] }] },
      ],
    };
    rehypeStreamWords()(tree);
    expect(tree.children[0].children.filter((c: any) => c.type === 'element').length).toBe(2);
    expect(tree.children[1].children[0].children).toEqual([{ type: 'text', value: 'x y' }]);
  });
});
