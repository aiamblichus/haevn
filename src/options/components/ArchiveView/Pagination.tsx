interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
  className?: string;
}

export const Pagination = ({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  className = "",
}: PaginationProps) => {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return (
    <div className={`flex items-center justify-between gap-3 ${className}`}>
      <div className="text-sm text-haevn-teal-light/70">
        {start}-{end} of {total}
      </div>
      <div className="flex items-center gap-2">
        <select
          className="p-2 border border-haevn-teal/30 bg-haevn-navy-dark/60 rounded-md text-sm text-haevn-teal-light focus:ring-2 focus:ring-haevn-teal focus:outline-none"
          value={String(pageSize)}
          onChange={(e) => onPageSizeChange(parseInt((e.target as HTMLSelectElement).value, 10))}
        >
          <option value="10">10</option>
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
        <div className="flex items-center gap-1">
          <button
            className="px-3 py-1 rounded-md border border-haevn-teal/30 bg-haevn-navy-dark/60 text-haevn-teal-light hover:bg-haevn-teal/20 hover:text-haevn-teal-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Prev
          </button>
          <span className="text-sm text-haevn-teal-light">
            Page {page} / {totalPages}
          </span>
          <button
            className="px-3 py-1 rounded-md border border-haevn-teal/30 bg-haevn-navy-dark/60 text-haevn-teal-light hover:bg-haevn-teal/20 hover:text-haevn-teal-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};
