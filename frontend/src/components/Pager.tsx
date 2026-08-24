/**
 * Page-number pagination control for admin tables.
 *
 * Stateless: the parent owns `page` (0-based) and `pageSize`, passes
 * `total`, and gets `onPage`. Hidden entirely when everything fits on
 * one page so small tables stay clean.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;        // 0-based
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 mt-4 text-xs text-ink-2">
      <span>
        第 <b className="text-ink">{from}–{to}</b> 项 · 共 <b className="text-ink">{total}</b>
      </span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 0}
          className="px-2.5 py-1 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← 上一页
        </button>
        <span className="px-1.5">
          第 <b className="text-ink">{page + 1}</b> / {pages} 页
        </span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page + 1 >= pages}
          className="px-2.5 py-1 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          下一页 →
        </button>
      </div>
    </div>
  );
}
