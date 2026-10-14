import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({ component: Privacy });

function Privacy() {
  return (
    <main className="min-h-screen bg-market-bg px-4 py-10">
      <article className="mx-auto max-w-3xl rounded-3xl border border-market-line bg-white p-6 shadow-market sm:p-9">
        <Link to="/" className="font-black text-market-green">ELEMARKET</Link>
        <h1 className="mt-5 text-3xl font-black">Privacy notice</h1>
        <p className="mt-2 text-sm text-market-muted">Last updated: <time dateTime="2026-10-03">3 October 2026</time></p>
        <div className="mt-7 space-y-7 text-sm leading-7 text-market-muted">
          <section aria-labelledby="privacy-scope">
            <h2 id="privacy-scope" className="text-lg font-black text-market-ink">1. About this notice</h2>
            <p>This notice explains how ELEMARKET uses information when you browse the marketplace, create an account, place an order, apply as a merchant or financing applicant, or contact Support through the website or mobile app.</p>
          </section>
          <section aria-labelledby="privacy-information">
            <h2 id="privacy-information" className="text-lg font-black text-market-ink">2. Information used by the service</h2>
            <ul className="list-disc space-y-2 pl-5">
              <li><strong>Account and contact information:</strong> your name, email address, phone number, profile details, sign-in and verification records.</li>
              <li><strong>Orders and delivery:</strong> items, quantities, delivery addresses and coordinates, order history, payment references and statuses, cancellations, returns and refund records.</li>
              <li><strong>Messages and content:</strong> support conversations, reviews, questions, listings and documents you submit.</li>
              <li><strong>Business and financing applications:</strong> the identity, business, financial and verification information requested in the application you choose to submit.</li>
              <li><strong>Service activity:</strong> account and security events, request information used to limit abuse, and campaign impressions and clicks. If you enable push notifications, the service also stores a device notification token.</li>
            </ul>
            <p>Payment providers collect the payment credentials needed for their payment flow. ELEMARKET uses provider references and payment statuses to track orders and refunds. Do not send card details, passwords or verification codes in support messages.</p>
          </section>
          <section aria-labelledby="privacy-use">
            <h2 id="privacy-use" className="text-lg font-black text-market-ink">3. How information is used</h2>
            <p>Information is used to verify and secure accounts, show listings, process orders, arrange delivery, send service messages, handle support and refund requests, review merchant and financing applications, prevent abuse and understand marketplace and campaign activity. Records also support dispute handling, transaction reconciliation and audit requirements.</p>
          </section>
          <section aria-labelledby="privacy-sharing">
            <h2 id="privacy-sharing" className="text-lg font-black text-market-ink">4. Who receives information</h2>
            <p>Relevant order and delivery information is shared with the merchants and delivery services fulfilling your order. Payment, financing and verification providers receive information needed for the service you request. Providers for hosting, storage, email, SMS, push notifications and address lookup process information needed to operate those features.</p>
            <p>Authorized marketplace staff can access information needed for support, reviews, security and administration. Reviews and other content submitted for publication may be visible to other users. Information may also be disclosed when required by law or to address fraud, disputes or threats to the service.</p>
            <p>Providers may process information outside Ghana, depending on the hosting and services used. A provider’s own privacy notice applies to information it collects directly through its payment, financing or other service.</p>
          </section>
          <section aria-labelledby="privacy-storage">
            <h2 id="privacy-storage" className="text-lg font-black text-market-ink">5. Cookies, device storage and permissions</h2>
            <p>The website uses cookies for authentication and stores your cart in browser storage. A first-party campaign measurement cookie identifies repeat visits for impression and click counting and expires after 30 days unless renewed. The mobile app uses device storage for the session, cart and pending payment flow.</p>
            <p>You can clear browser cookies and storage, but doing so may sign you out or remove your saved cart. Location and push notification permissions are controlled through your browser or device settings. You can disable those permissions there; features that rely on them may then be unavailable.</p>
          </section>
          <section aria-labelledby="privacy-retention">
            <h2 id="privacy-retention" className="text-lg font-black text-market-ink">6. Protection and retention</h2>
            <p>ELEMARKET uses access controls and security measures to protect account and sensitive application information. Keep your own credentials private and report suspected unauthorized access through Support.</p>
            <p>Retention depends on the type of record and its purpose. Account and order information supports the service and your transaction history. Transaction, refund, dispute, fraud and audit records may need to be retained after account closure to meet legal requirements or resolve outstanding matters. Requesting deletion does not automatically erase those records.</p>
          </section>
          <section aria-labelledby="privacy-choices">
            <h2 id="privacy-choices" className="text-lg font-black text-market-ink">7. Your choices and requests</h2>
            <p>You can update supported profile fields in your account. To ask about your information, request access or correction, or request account closure or deletion, sign in and contact <Link to="/support" className="font-bold text-market-green underline">ELEMARKET Support</Link>. Describe the request without including passwords, verification codes or full payment-card details. Identity verification may be needed before account information can be released or changed.</p>
            <p>If you have a concern about the handling of personal information, you can also contact Ghana’s <a href="https://dpc.gov.gh/file-a-complaint/" className="font-bold text-market-green underline">Data Protection Commission</a>.</p>
          </section>
          <section aria-labelledby="privacy-updates">
            <h2 id="privacy-updates" className="text-lg font-black text-market-ink">8. Updates and contact</h2>
            <p>This notice may change as marketplace features and providers change. The date above identifies the current version. Send questions about this notice through <Link to="/support" className="font-bold text-market-green underline">ELEMARKET Support</Link>. See our <Link to="/terms" className="font-bold text-market-green underline">Terms of service</Link> for order, payment and marketplace rules.</p>
          </section>
        </div>
      </article>
    </main>
  );
}
