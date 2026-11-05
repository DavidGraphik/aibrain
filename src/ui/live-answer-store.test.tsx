// @vitest-environment jsdom
import { act, render, screen } from '../../tests/render-spanish';
import { expect, it } from 'vitest';
import { LiveAnswerStore, useLiveAnswer } from './live-answer-store';

it('paints each active answer without rendering its ancestor or leaking between workbenches/turns', () => {
  const first = new LiveAnswerStore(), second = new LiveAnswerStore();
  const key = first.key('thread', 'answer');
  let parentRenders = 0;
  function Answer({ store, id, label }: { store: LiveAnswerStore; id: string; label: string }) {
    const text = useLiveAnswer(store, id);
    return <p aria-label={label}>{text ?? 'persisted fallback'}</p>;
  }
  function Parent() {
    parentRenders++;
    return <><Answer store={first} id={key} label='First' /><Answer store={first} id='another-turn' label='Other turn' /><Answer store={second} id={key} label='Other workbench' /></>;
  }
  render(<Parent />);
  const initialRenders = parentRenders;
  for (let n = 1; n <= 144; n++) {
    act(() => first.write(key, `Exact delta ${n}`));
    expect(screen.getByLabelText('First')).toHaveTextContent(`Exact delta ${n}`);
  }
  expect(parentRenders).toBe(initialRenders);
  expect(screen.getByLabelText('Other turn')).toHaveTextContent('persisted fallback');
  expect(screen.getByLabelText('Other workbench')).toHaveTextContent('persisted fallback');
  act(() => first.retain(new Set(['another-turn'])));
  expect(screen.getByLabelText('First')).toHaveTextContent('persisted fallback');
});
