export function ConfigMaskedSection({ maskedConfig }: { maskedConfig: Record<string, unknown> }) {
  return (
    <section className="card">
      <h2>Config (masked)</h2>
      <pre>{JSON.stringify(maskedConfig, null, 2)}</pre>
    </section>
  );
}
