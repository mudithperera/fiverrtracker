/**
 * Privacy policy and terms, served from this API so they have a public URL.
 *
 * The Chrome Web Store will not approve an extension that requests OAuth scopes
 * without a privacy policy at a reachable address, and its Limited Use disclosure
 * has to be stated explicitly.
 *
 * Written to match what the code actually does. If you change what is collected,
 * change this in the same commit — a policy that describes the previous version is
 * worse than none, because it is a statement you are now failing to honour.
 *
 * `LEGAL_ENTITY` and `JURISDICTION` must be filled in before launch.
 */

export const LEGAL_ENTITY = 'RankPeek';
export const JURISDICTION = 'Sri Lanka';
export const CONTACT_EMAIL = 'support@rankpeek.app';
export const LAST_UPDATED = '27 July 2026';

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  h1 { font-size: 1.7rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; }
  .updated { color: #6b7280; margin-top: 0; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.35rem 0; }
  code { font-size: 0.9em; }
  a { color: #0a7f4b; }
  @media (prefers-color-scheme: dark) { a { color: #47eda0; } .updated { color: #9aa8b2; } }
`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — RankPeek</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;

export const PRIVACY_HTML = page(
  'Privacy Policy',
  `
<h1>Privacy Policy</h1>
<p class="updated">Last updated ${LAST_UPDATED}</p>

<p>RankPeek is a Chrome extension that reports where a Fiverr gig ranks for a
keyword. This policy explains exactly what it collects and why.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Your Google account details</strong> — email address, name, profile
      picture and Google account identifier — but only if you choose to sign in.
      We receive these from Google; we never see your Google password.</li>
  <li><strong>Subscription status</strong>, if you subscribe. Payments are handled
      entirely by Stripe. We store only the Stripe customer and subscription
      identifiers and the plan state. <strong>We never receive or store your card
      details.</strong></li>
  <li><strong>Usage counts</strong> — the number of ranking checks you run each
      day, so plan limits can be applied.</li>
  <li><strong>Keywords you choose to track</strong>, together with the Fiverr
      username and country you asked us to track them for.</li>
</ul>

<h2>What stays on your own computer</h2>
<p>Your scan settings, your scan results and history, your appearance preference
and your sign-in token are stored locally in the browser using
<code>chrome.storage</code>. Ranking checks you run by hand are not uploaded.</p>

<h2>What we do not collect</h2>
<ul>
  <li>Your browsing history, or any page other than Fiverr search results.</li>
  <li>Your Fiverr account credentials. The extension reads publicly visible search
      results in your own browser; it never signs in as you.</li>
  <li>Payment card details.</li>
</ul>

<h2>How the extension uses Fiverr pages</h2>
<p>To find your ranking, the extension opens Fiverr search pages in a tab and reads
the public list of results — the same information any visitor sees. It reads gig
identifiers and links to work out positions. It does not modify Fiverr, place
orders, or interact with your Fiverr account.</p>

<h2>Limited Use disclosure</h2>
<p>RankPeek's use of information received from Google APIs adheres to the
<a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use/">Chrome
Web Store User Data Policy</a>, including the Limited Use requirements. We use
Google sign-in solely to identify your account. We do not sell this data, use it
for advertising, or allow humans to read it except where required for support with
your permission, for security, or where required by law.</p>

<h2>Who else processes your data</h2>
<ul>
  <li><strong>Google</strong> — sign-in.</li>
  <li><strong>Stripe</strong> — payments and subscription management.</li>
  <li><strong>Our hosting and database providers</strong> — to run the service.</li>
</ul>
<p>We do not sell your data, and we do not share it for advertising.</p>

<h2>Keeping and deleting your data</h2>
<p>We keep your account data until you delete it. You can delete your account at
any time from the extension: <strong>Menu → Account → Delete account</strong>.
That removes your account, subscription record, usage counts and tracked keywords
immediately and permanently. You can also email
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we will do it for you.</p>

<p>Deleting your account does not automatically cancel a subscription billed
through Stripe — cancel it first from Menu → Account → Manage subscription, or ask
us and we will cancel it for you.</p>

<h2>Your rights</h2>
<p>You can ask for a copy of your data, ask us to correct it, or ask us to erase
it, by writing to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

<h2>Children</h2>
<p>RankPeek is not intended for anyone under 16.</p>

<h2>Changes</h2>
<p>If this policy changes materially we will update the date above and, for
significant changes, tell you in the extension.</p>

<h2>Contact</h2>
<p>${LEGAL_ENTITY}, ${JURISDICTION} —
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`,
);

export const TERMS_HTML = page(
  'Terms of Service',
  `
<h1>Terms of Service</h1>
<p class="updated">Last updated ${LAST_UPDATED}</p>

<h2>What RankPeek does</h2>
<p>RankPeek reports where a Fiverr gig appears in Fiverr's public search results
for a keyword. It reads those results in your own browser.</p>

<h2>What it cannot promise</h2>
<p>Rankings are Fiverr's, not ours. They change constantly, differ between
visitors and locations, and Fiverr can change how its search works without notice.
We report what we observe at the time we observe it. We do not promise that a
position will hold, that a scan will always succeed, or that Fiverr will remain
readable by this tool.</p>

<h2>Acceptable use</h2>
<p>Use RankPeek for your own gigs and ordinary competitor research. Do not use it
to overload Fiverr, to resell our output as your own service, or for anything
unlawful. We may suspend an account that does.</p>

<h2>Subscriptions</h2>
<p>Paid plans are billed in advance through Stripe, monthly or yearly as you
choose, and renew automatically until cancelled. Cancel any time from Menu →
Account → Manage subscription; access continues to the end of the period you have
paid for. We do not give partial refunds for unused time, but if the service did
not work as described, write to us and we will make it right.</p>

<h2>Price changes</h2>
<p>We may change prices for future billing periods. Existing subscribers will be
told before a change affects them.</p>

<h2>Ending the service</h2>
<p>You can stop using RankPeek and delete your account at any time. If we ever
discontinue the service, we will give notice and refund any period paid for but
not delivered.</p>

<h2>Liability</h2>
<p>RankPeek is provided as is. To the extent the law allows, our liability is
limited to the amount you paid us in the twelve months before the claim. Nothing
here limits liability that cannot lawfully be limited.</p>

<h2>Contact</h2>
<p>${LEGAL_ENTITY}, ${JURISDICTION} —
<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`,
);
