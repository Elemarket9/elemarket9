import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({ component: Terms });

function Terms() {
  return (
    <main className="min-h-screen bg-market-bg px-4 py-10">
      <article className="mx-auto max-w-3xl rounded-3xl border border-market-line bg-white p-6 shadow-market sm:p-9">
        <Link to="/" className="font-black text-market-green">ELEMARKET</Link>
        <h1 className="mt-5 text-3xl font-black">Terms of service</h1>
        <p className="mt-2 text-sm text-market-muted">Last updated: <time dateTime="2026-10-03">3 October 2026</time></p>
        <div className="mt-7 space-y-7 text-sm leading-7 text-market-muted">
          <section aria-labelledby="terms-marketplace">
            <h2 id="terms-marketplace" className="text-lg font-black text-market-ink">1. Using the marketplace</h2>
            <p>These terms apply to your use of the ELEMARKET website and mobile app. ELEMARKET connects customers with merchants and helps manage orders, delivery requests, payments and support. The marketplace currently supports Ghana delivery locations and prices in Ghana cedis (GHS).</p>
            <p>Merchants are responsible for their listings, product quality, stock, fulfilment and any product-specific warranties. Review the listing and checkout information before ordering. If you are acting for a business, you must have authority to use the service on its behalf.</p>
          </section>
          <section aria-labelledby="terms-account">
            <h2 id="terms-account" className="text-lg font-black text-market-ink">2. Your account</h2>
            <p>Provide accurate account, contact and delivery details and complete the verification steps requested by the service. Keep your sign-in credentials and verification codes private. Tell ELEMARKET Support if you suspect someone has accessed your account without permission.</p>
            <p>You must not impersonate another person, use another person’s payment method without permission, or provide false identity or business information.</p>
          </section>
          <section aria-labelledby="terms-orders">
            <h2 id="terms-orders" className="text-lg font-black text-market-ink">3. Orders and payments</h2>
            <p>Check the items, quantities, delivery address, delivery charge, discounts and total shown at checkout before submitting an order. Prices and availability can change before checkout. An item in your cart does not guarantee that stock is reserved.</p>
            <p>Payments are processed by the payment provider shown during checkout. ELEMARKET does not hold customer funds. A payment screen or bank notification alone does not confirm an order as paid; check the order status after the provider confirms payment. Contact Support if you were charged but the order status has not updated, and avoid paying again until the payment has been checked.</p>
            <p>Separate merchants may have separate orders and payment steps. Where financing is offered, the financing provider decides eligibility and supplies the credit agreement, repayment terms and any charges. An application does not guarantee approval.</p>
          </section>
          <section aria-labelledby="terms-delivery">
            <h2 id="terms-delivery" className="text-lg font-black text-market-ink">4. Delivery and fulfilment</h2>
            <p>Delivery options and charges depend on the merchant, destination and available delivery service. Delivery times shown are estimates. Keep your address and contact details accurate, and check your order for fulfilment updates. Use Support to report a missing, damaged or incorrect delivery.</p>
          </section>
          <section aria-labelledby="terms-returns">
            <h2 id="terms-returns" className="text-lg font-black text-market-ink">5. Cancellations, returns and refunds</h2>
            <p>Use the actions on your order to request cancellation or a return when eligible. Cancellation availability depends on the order’s current stage. Return eligibility and the return window depend on the product’s stated return conditions and delivery status. If an action is unavailable or an item is faulty, incorrect or missing, contact Support with the order reference and relevant details.</p>
            <p>A request does not itself confirm a cancellation, return or refund. Follow the instructions provided for your case before sending an item back. Approved payment refunds are processed through the payment provider; completion and the time funds appear depend on that provider and your payment method. Check the order or refund status and contact Support if you need help.</p>
            <p>These terms and product-specific return conditions do not remove rights you have under applicable law.</p>
          </section>
          <section aria-labelledby="terms-conduct">
            <h2 id="terms-conduct" className="text-lg font-black text-market-ink">6. Responsible use</h2>
            <p>Do not list unlawful or counterfeit goods, submit misleading reviews, harass other users, exploit promotions, make fraudulent payment or refund claims, or attempt to bypass account and security controls. Only upload content you have permission to share.</p>
            <p>ELEMARKET may restrict accounts, listings or integrations to investigate abuse, protect users, comply with applicable requirements or maintain the service. Contact Support if you believe a restriction is a mistake.</p>
          </section>
          <section aria-labelledby="terms-availability">
            <h2 id="terms-availability" className="text-lg font-black text-market-ink">7. Service availability and changes</h2>
            <p>Features and availability may change and interruptions may occur. Report errors through Support. These terms may be updated as the service changes; the date above identifies the current version. Review the terms and the information shown for each new order.</p>
          </section>
          <section aria-labelledby="terms-contact">
            <h2 id="terms-contact" className="text-lg font-black text-market-ink">8. Support and privacy</h2>
            <p>For questions about an order, these terms or your account, sign in and contact <Link to="/support" className="font-bold text-market-green underline">ELEMARKET Support</Link>. Include the order reference when relevant, but never send passwords, verification codes or full payment-card details.</p>
            <p>Our <Link to="/privacy" className="font-bold text-market-green underline">Privacy notice</Link> explains the information used to operate the marketplace and how to make a privacy request.</p>
          </section>
        </div>
      </article>
    </main>
  );
}
