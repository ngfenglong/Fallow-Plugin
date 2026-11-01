/** The dashboard's page header: its title and the one note that belongs above everything
 * else — automation being off, which affects every count and action on the page. */
export function Header({ automationNote }: { automationNote: string | null }) {
  return (
    <header className="dashboard-header">
      <h1>Fallow dashboard</h1>
      <a className="btn" href="#settings">Settings</a>
      {automationNote !== null ? <p>{automationNote}</p> : null}
    </header>
  );
}
