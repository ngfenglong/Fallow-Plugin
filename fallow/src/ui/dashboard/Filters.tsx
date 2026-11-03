export type SortKey = 'order' | 'unused' | 'title';
export type FilterKey = 'all' | 'loaded' | 'unloaded' | 'eligible' | 'protected';

/**
 * Search, sort and filter controls, plus the scope label that says how many of the total
 * the current filter/search is actually showing (A18: a filtered view must never let its
 * own counts be mistaken for the whole picture). No RAM sort is offered (F1): no
 * measurement provider exists to order by in this version.
 */
export function Filters({
  search, onSearch, sort, onSort, filter, onFilter, scopeLabel,
}: {
  search: string; onSearch: (next: string) => void;
  sort: SortKey; onSort: (next: SortKey) => void;
  filter: FilterKey; onFilter: (next: FilterKey) => void;
  scopeLabel: string;
}) {
  return (
    <section className="panel filters" aria-label="Filters">
      <label>
        <span>Search</span>
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>
      <label>
        <span>Sort by</span>
        <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)}>
          <option value="order">Tab order</option>
          <option value="unused">Longest unused</option>
          <option value="title">Title</option>
        </select>
      </label>
      <label>
        <span>Show</span>
        <select value={filter} onChange={(e) => onFilter(e.target.value as FilterKey)}>
          <option value="all">All</option>
          <option value="loaded">Loaded</option>
          <option value="unloaded">Unloaded</option>
          <option value="eligible">Eligible</option>
          <option value="protected">Protected</option>
        </select>
      </label>
      <p data-testid="scope-label">{scopeLabel}</p>
    </section>
  );
}
