// TKT-003 decision:
// Keep the existing CSS primitives instead of adding Material UI.
// Rationale: this dashboard already has consistent custom tokens/classes in globals.css,
// and staying with them is the fastest path to parity with minimal dependency/runtime overhead.
export function PageHeader({
  botBase,
  revision,
  routeCount,
}: {
  botBase: string;
  revision: string;
  routeCount: number;
}) {
  return (
    <>
      <h1>Flightbot dashboard</h1>
      <p className="muted">
        Bot base: <code>{botBase}</code> - config revision <strong>{revision}</strong>, <strong>{routeCount}</strong> route(s).
      </p>
    </>
  );
}
