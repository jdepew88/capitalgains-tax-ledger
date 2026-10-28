// Plain-English background. Checked against the IRS pages linked below on the review date shown.
// When updating, re-check each source and change REVIEWED_ON.

const REVIEWED_ON = "October 27, 2026";

const SOURCES = [
  { title: "Publication 523 (2025), Selling Your Home", url: "https://www.irs.gov/publications/p523", note: "for 2025 returns; IRS page last updated April 30, 2026" },
  { title: "Publication 505 (2026), Tax Withholding and Estimated Tax", url: "https://www.irs.gov/publications/p505", note: "for 2026" },
  { title: "Get an extension to file your tax return", url: "https://www.irs.gov/filing/get-an-extension-to-file-your-tax-return", note: "IRS page last updated September 20, 2026" },
  { title: "File an amended return", url: "https://www.irs.gov/filing/file-an-amended-return", note: "IRS page last updated September 30, 2026" },
];

export function AboutPage() {
  return (
    <article class="panel about">
      <a class="back-link" href="#/">← Back to the ledger</a>
      <h1>Why we keep these records</h1>
      <p class="reviewed">Checked against the IRS sources below on <strong>{REVIEWED_ON}</strong>. This is general information, not tax advice.</p>

      <h2>The short version</h2>
      <ul>
        <li>When a home is sold, the taxable gain is roughly the sale amount minus the home’s <strong>adjusted basis</strong> (what was paid for it, plus certain costs).</li>
        <li>Qualifying <strong>improvements</strong> — work that adds value, makes the home last longer, or adapts it to new uses, like a new roof or an addition — can be added to the basis. A higher basis means a smaller gain, which may mean less tax.</li>
        <li><strong>A dollar spent is not a dollar of tax saved.</strong> An improvement reduces the gain; how much tax that saves (if any) depends on the rest of the tax picture.</li>
        <li>This app only organizes the evidence. <strong>The tax preparer decides</strong> how each item is treated. “Approved for basis” here means one of us reviewed it — not that the IRS approved anything.</li>
      </ul>

      <h2>What may not count, or may count for less</h2>
      <ul>
        <li><strong>Ordinary repairs and maintenance</strong> that just keep the home in good condition (though repair work done as part of a larger remodeling or restoration job can be included).</li>
        <li><strong>Improvements that are no longer part of the home</strong> — for example, carpet that was later replaced.</li>
        <li><strong>Credits, subsidies and reimbursements</strong> — for example, energy credits or subsidies received for an improvement, and insurance reimbursements for damage — reduce the basis.</li>
        <li><strong>Other adjustments</strong>, such as depreciation if part of the home was used for business or rented, or casualty losses that were deducted.</li>
      </ul>

      <h2>The home-sale exclusion</h2>
      <p>
        Many sellers can exclude up to <strong>$250,000</strong> of gain (<strong>$500,000</strong> for many married couples filing jointly)
        if they generally owned the home and lived in it as their main home for at least 2 of the 5 years before the sale. Other
        rules and exceptions apply. Whether it applies depends on the owner’s circumstances, and records of improvements can
        still matter — so we keep them and let the preparer decide.
      </p>

      <h2>Refunds</h2>
      <p>
        If too much tax was paid, a refund may come when the return is filed, or by filing a corrected (amended) return —
        generally within 3 years after the original return was filed or 2 years after the tax was paid, whichever is later.
        A refund isn’t guaranteed.
      </p>

      <h2>How long to keep records</h2>
      <p>The IRS suggests keeping records that support the home’s basis until at least 3 years after the due date of the tax return for the year the home is sold.</p>

      <h2>Calendar quarters vs. IRS estimated-tax periods</h2>
      <p><strong>Calendar quarters</strong> are four equal three-month blocks: January–March, April–June, July–September and October–December.</p>
      <p>
        The IRS <strong>estimated tax</strong> payment periods for individuals are <em>not</em> four equal quarters. For 2026 (calendar-year taxpayers):
      </p>
      <div class="table-wrap">
        <table class="simple-table">
          <thead><tr><th>Income received</th><th>Length</th><th>Payment due</th></tr></thead>
          <tbody>
            <tr><td>January 1 – March 31</td><td>3 months</td><td>April 15, 2026</td></tr>
            <tr><td>April 1 – May 31</td><td>2 months</td><td>June 15, 2026</td></tr>
            <tr><td>June 1 – August 31</td><td>3 months</td><td>September 15, 2026</td></tr>
            <tr><td>September 1 – December 31</td><td>4 months</td><td>January 15, 2027</td></tr>
          </tbody>
        </table>
      </div>
      <ul>
        <li>If a due date falls on a <strong>Saturday, Sunday or legal holiday</strong>, a payment made on the next business day is on time.</li>
        <li>The January payment isn’t required if the full return is filed and all tax due is paid by January 31.</li>
        <li>People whose tax year doesn’t start January 1 (fiscal-year filers) have different dates.</li>
      </ul>

      <h2>The annual filing deadline and extensions</h2>
      <ul>
        <li>The federal individual return is usually due <strong>April 15</strong> (the next business day if that’s a weekend or holiday).</li>
        <li>An extension gives until <strong>October 15</strong> to <em>file</em>, but it generally <strong>does not extend the time to pay</strong>. Tax owed is still due by the April deadline.</li>
        <li>State deadlines and rules can be different, and individual circumstances (for example, IRS disaster-relief postponements) can change the dates.</li>
      </ul>

      <h2>Sources</h2>
      <ul class="sources">
        {SOURCES.map((s) => (
          <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a> <span class="muted small">— {s.note}</span></li>
        ))}
      </ul>
    </article>
  );
}
