import { SelectionExecutor } from './selection.executor';

/**
 * Regression tests for the inescapable clarify_selection loop.
 *
 * process_selection -> selection executor -> 'unclear' -> clarify_selection -> back to
 * process_selection. With zero cards on screen parseSelection can never match anything,
 * so 'unclear' was guaranteed forever while the prompt asked the user to click an ADD
 * button that did not exist. Observed 8 times in one real session on 2026-08-17.
 */
describe('SelectionExecutor — unparseable input must not trap the user', () => {
  let executor: SelectionExecutor;
  const ctx = (data: Record<string, any>) => ({ data }) as any;
  const oneCard = [{ id: 1, name: 'Veg Biryani', price: 235, storeId: 269 }];

  beforeEach(() => {
    executor = new SelectionExecutor();
  });

  it('searches for what the user typed when nothing is on screen', async () => {
    const result = await executor.execute(
      {},
      ctx({ _user_message: 'Show me items', search_results: { cards: [] } }),
    );

    expect(result.event).toBe('search_items');
    expect((result.output as any).searchSuggestion).toBe('Show me items');
  });

  it('treats a missing search_results the same as an empty one', async () => {
    const result = await executor.execute({}, ctx({ _user_message: 'kuch dikhao' }));

    expect(result.event).toBe('search_items');
    expect((result.output as any).searchSuggestion).toBe('kuch dikhao');
  });

  it('still asks for clarification on the first unclear message when cards ARE on screen', async () => {
    const result = await executor.execute(
      {},
      ctx({ _user_message: 'hmm ???', search_results: { cards: oneCard } }),
    );

    expect(result.event).toBe('unclear');
    expect((result.output as any).unclearAttempts).toBe(1);
  });

  it('gives up and searches after three unclear messages even with cards on screen', async () => {
    const result = await executor.execute(
      {},
      ctx({
        _user_message: 'hmm ???',
        search_results: { cards: oneCard },
        selection_result: { unclearAttempts: 2 },
      }),
    );

    expect(result.event).toBe('search_items');
    expect((result.output as any).searchSuggestion).toBe('hmm ???');
  });

  it('sets a searchSuggestion on the resolved-entities safeguard path', async () => {
    // This path returned no `output` at all, so search_requested_items interpolated
    // {{selection_result.searchSuggestion}} to an empty query.
    const result = await executor.execute(
      {},
      ctx({
        _user_message: 'biryani from inayat cafe',
        resolved_entities: { items: ['biryani'], stores: [] },
      }),
    );

    expect(result.event).toBe('search_items');
    expect((result.output as any).searchSuggestion).toBe('biryani from inayat cafe');
  });
});
