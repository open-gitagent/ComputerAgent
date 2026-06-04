import * as React from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "../../lib/cn.ts";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table.tsx";
import { Skeleton } from "../ui/skeleton.tsx";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  /** Render the cell content for a row. */
  cell: (row: T) => React.ReactNode;
  /** Tailwind class applied to the th + td. */
  className?: string;
  align?: "left" | "right" | "center";
  /** If set, the header becomes a sort button using this accessor. */
  sortBy?: (row: T) => string | number;
};

export function DataTable<T>({
  columns,
  rows,
  loading,
  empty,
  onRowClick,
  rowKey,
  className,
  initialSortKey = null,
  initialSortDir = "desc",
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  rowKey: (row: T, index: number) => string;
  className?: string;
  /** Column key to sort by on first render (must have a `sortBy`). */
  initialSortKey?: string | null;
  /** Initial sort direction when `initialSortKey` is set. */
  initialSortDir?: "asc" | "desc";
}) {
  const [sortKey, setSortKey] = React.useState<string | null>(initialSortKey);
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">(initialSortDir);

  const sorted = React.useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortBy) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
      const av = col.sortBy!(a);
      const bv = col.sortBy!(b);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, sortKey, sortDir, columns]);

  const onSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  if (loading) {
    return (
      <div className={cn("space-y-1 p-3", className)}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <div className={className}>{empty}</div>;
  }

  return (
    <Table
      className={cn(
        // Align first/last cell horizontal padding with the page header (px-6).
        "[&_th:first-child]:pl-6 [&_th:last-child]:pr-6 [&_td:first-child]:pl-6 [&_td:last-child]:pr-6",
        className,
      )}
    >
      <TableHeader>
        <TableRow>
          {columns.map((c) => {
            const sortable = !!c.sortBy;
            const active = sortKey === c.key;
            const justify = c.align === "right" ? "justify-end" : c.align === "center" ? "justify-center" : "justify-start";
            return (
              <TableHead key={c.key} className={c.className}>
                {sortable ? (
                  <button
                    type="button"
                    onClick={() => onSort(c.key)}
                    className={cn("inline-flex items-center gap-1 text-inherit hover:text-foreground transition-colors", justify, "w-full")}
                  >
                    <span>{c.header}</span>
                    {active && sortDir === "asc" && <ArrowUp className="h-3 w-3" />}
                    {active && sortDir === "desc" && <ArrowDown className="h-3 w-3" />}
                  </button>
                ) : (
                  <span className={cn("inline-flex w-full", justify)}>{c.header}</span>
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row, idx) => (
          <TableRow
            key={rowKey(row, idx)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(onRowClick && "cursor-pointer")}
          >
            {columns.map((c) => {
              const align = c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";
              return (
                <TableCell key={c.key} className={cn(align, c.className)}>
                  {c.cell(row)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
