export function StatusSection({ status }: { status: unknown }) {
  return (
    <section className="card">
      <h2>Status</h2>
      <pre>{JSON.stringify(status, null, 2)}</pre>
    </section>
  );
}
