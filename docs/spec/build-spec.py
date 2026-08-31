#!/usr/bin/env python3
"""Builds the Retargetng data-capture integration specification PDF (for the client's developer)."""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, KeepTogether, ListFlowable, ListItem,
                                PageBreak, PageTemplate, Paragraph, Preformatted, Spacer, Table, TableStyle)

OUT = "Retargetng-Data-Capture-Spec.pdf"

INK = colors.HexColor("#12141c")
MUTED = colors.HexColor("#5b6172")
ACCENT = colors.HexColor("#4f46e5")
RULE = colors.HexColor("#dcdfe8")
BG_SOFT = colors.HexColor("#f4f5fa")
OK = colors.HexColor("#15803d")
NO = colors.HexColor("#b91c1c")

ss = getSampleStyleSheet()
body = ParagraphStyle("body", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.3, leading=13.4,
                      textColor=INK, spaceAfter=7, alignment=TA_LEFT)
small = ParagraphStyle("small", parent=body, fontSize=8.2, leading=11.6, textColor=MUTED)
h1 = ParagraphStyle("h1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=17, leading=21,
                    textColor=INK, spaceBefore=2, spaceAfter=4)
h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, leading=16,
                    textColor=INK, spaceBefore=15, spaceAfter=6)
h3 = ParagraphStyle("h3", parent=ss["Heading3"], fontName="Helvetica-Bold", fontSize=10, leading=13.5,
                    textColor=ACCENT, spaceBefore=10, spaceAfter=4)
cell = ParagraphStyle("cell", parent=body, fontSize=8.3, leading=11.2, spaceAfter=0)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Helvetica-Bold")
cellm = ParagraphStyle("cellm", parent=cell, fontName="Courier", fontSize=7.6, leading=10.4)
code = ParagraphStyle("code", parent=ss["Code"], fontName="Courier", fontSize=7.4, leading=10.2,
                      textColor=INK, backColor=BG_SOFT, borderPadding=7, spaceBefore=3, spaceAfter=9,
                      leftIndent=0, borderColor=RULE, borderWidth=0.5)


def P(t, s=body):
    return Paragraph(t, s)


def bullets(items, style=body):
    return ListFlowable([ListItem(Paragraph(i, style), leftIndent=13) for i in items],
                        bulletType="bullet", start="\u2022", bulletFontSize=7, bulletOffsetY=-0.5,
                        leftIndent=11, spaceAfter=8, bulletColor=ACCENT)


def table(rows, widths, header=True, zebra=True, font_sizes=None):
    data = []
    for r_i, row in enumerate(rows):
        out = []
        for c_i, c in enumerate(row):
            if isinstance(c, Paragraph):
                out.append(c)
            else:
                st = cellb if (header and r_i == 0) else cell
                if font_sizes and c_i in font_sizes:
                    st = ParagraphStyle(f"s{r_i}{c_i}", parent=st, fontName=font_sizes[c_i])
                out.append(Paragraph(str(c), st))
        data.append(out)
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), BG_SOFT), ("LINEBELOW", (0, 0), (-1, 0), 0.8, RULE)]
    if zebra:
        for i in range(1 if header else 0, len(data)):
            if (i % 2) == (0 if header else 1):
                style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fbfbfd")))
    t.setStyle(TableStyle(style))
    return t


def callout(title, text, tone=ACCENT):
    hexcolor = '#' + tone.hexval()[2:]
    inner = Table([[Paragraph(f'<font color="{hexcolor}"><b>{title}</b></font>  {text}', cell)]],
                  colWidths=[168 * mm], hAlign="LEFT")
    inner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BG_SOFT),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, tone),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ]))
    return inner


story = []
A = story.append

# ── Cover ────────────────────────────────────────────────────────────────────
A(Spacer(1, 6 * mm))
A(P('<font color="#4f46e5"><b>RETARGETNG</b></font>  ·  Audience Activation Platform', small))
A(Spacer(1, 3 * mm))
A(P("Data Capture &amp; Integration Specification", h1))
A(P("What to capture for retargeting on Meta and Google, how to send it, and what is deliberately out of scope.", small))
A(Spacer(1, 5 * mm))
A(table([
    ["Audience", "Web / backend developer implementing the integration"],
    ["System", "Retargetng — first-party audience activation &amp; retargeting engine"],
    ["Scope", "Event ingestion, ad click identifiers, identity match keys, conversions back-channel, consent"],
    ["Status", "Engine, ingestion API, audience engine and Meta/Google connectors are built. Items marked "
              "<b>PLANNED</b> are the work this document specifies."],
], [30 * mm, 138 * mm], header=False, zebra=False))
A(Spacer(1, 6 * mm))

A(P("1. The rule that shapes everything", h2))
A(P("Meta and Google <b>never</b> return a person's name, email, phone or device ID because they saw or clicked an ad. "
    "Advertisers only ever hold data that (a) the person gave to <i>you</i>, or (b) the platform passes as an opaque click "
    "identifier. Everything below respects that boundary.", body))
A(Spacer(1, 2 * mm))
A(table([
    ["✔ Can be captured", "✘ Cannot be captured"],
    [
        "Identity the customer gives you (email, phone, name, address) on signup, checkout, OTP login, forms<br/><br/>"
        "Behaviour on your own site/app (views, cart, purchases, search)<br/><br/>"
        "Ad click identifiers on your landing pages (fbclid, gclid, …)<br/><br/>"
        "Lead Ads form submissions (the user typed and consented)<br/><br/>"
        "Device advertising ID (GAID/IDFA) from <i>your own app</i>, with consent",
        "Name / email / phone of anyone who merely saw or clicked your ad<br/><br/>"
        "Device IDs of web ad viewers<br/><br/>"
        "The person's browsing on other websites<br/><br/>"
        "Another advertiser's customer list<br/><br/>"
        "Third-party cookie profiles (deprecated and non-compliant)",
    ],
], [84 * mm, 84 * mm]))
A(Spacer(1, 3 * mm))
A(callout("Compliance", "India's DPDP Act 2023 (and GDPR where applicable) requires notice and consent before personal data "
                        "is processed for advertising. Meta's Custom Audience terms and Google's Customer Match policy require the "
                        "same. Retargetng enforces this in code: a customer is never sent to a platform unless the consent flags "
                        "for that destination are satisfied.", NO))

# ── 2. Inventory ────────────────────────────────────────────────────────────
A(P("2. What to capture, and what each signal unlocks", h2))
A(P("Priority column: <b>P1</b> = required for the system to work, <b>P2</b> = high value, <b>P3</b> = nice to have.", small))

A(P("2.1 Identity &amp; match keys (from your own database / checkout)", h3))
A(table([
    ["Field", "Format to send", "Why it matters", "Priority"],
    ["email", "raw string; we normalise + hash", "Primary match key for Meta and Google", "P1"],
    ["phone", "raw or E.164 (+91…)", "Best match key in India; often beats email", "P1"],
    ["external_customer_id", "your customer/user id", "Stable identity across email/phone changes", "P1"],
    ["first_name, last_name", "raw text", "<b>Extra match keys</b> — Meta and Google both accept them hashed and match rate rises", "P2"],
    ["city, state, postal_code, country", "raw text / ISO-2 country", "Extra match keys; also geo audiences", "P2"],
    ["date_of_birth, gender", "YYYY-MM-DD / m|f", "Extra Meta match keys", "P3"],
    ["GAID / IDFA (mobile app only)", "raw advertising id", "Highest match rate on Meta; app campaigns", "P3"],
], [34 * mm, 40 * mm, 76 * mm, 18 * mm]))
A(Spacer(1, 2 * mm))
A(callout("Quick win", "Match rate today is ~84%. Sending first/last name, city, state and PIN code as additional hashed "
                       "keys is the cheapest way to raise it — the data is already in most customer tables."))

A(P("2.2 Commerce &amp; behaviour (from your storefront)", h3))
A(table([
    ["Signal", "Retargeting use", "Priority"],
    ["Product viewed (product id, category)", "Product / category retargeting, intent audiences", "P2"],
    ["Add to cart (cart id, product, qty, value)", "Cart abandoner 1–3d / 4–7d / 8–14d — highest-intent audiences", "P1"],
    ["Checkout started", "Abandoned-checkout audiences (higher intent than cart)", "P2"],
    ["Purchase (order id, total, items, currency)", "Removes buyers from cart audiences, powers LTV/AOV/VIP tiers and ROAS", "P1"],
    ["Order cancelled / refunded", "Corrects lifetime value; suppresses serial returners", "P2"],
    ["On-site search terms, wishlist", "\"Searched X, never bought\" audiences", "P3"],
    ["Session recency / count, last activity", "Dormant &amp; re-engagement audiences", "P3"],
    ["Consent granted / revoked", "Decides who may be activated at all (mandatory)", "P1"],
    ["Unsubscribe, complaint, fraud flag", "Global suppression", "P1"],
], [56 * mm, 92 * mm, 20 * mm]))

A(KeepTogether([P("2.3 Ad click identifiers (captured on your landing pages)", h3), table([
    ["Parameter", "Source", "Used for"],
    ["fbclid", "Meta ad click", "Attribution; becomes the <font face='Courier'>fbc</font> value for Conversions API"],
    ["gclid / wbraid / gbraid", "Google ad click", "Attribution; offline conversion &amp; enhanced conversion import"],
    ["ttclid, msclkid", "TikTok / Bing", "Same, for future destinations"],
    ["utm_source / medium / campaign / content / term", "Your ad URLs", "Campaign attribution and reporting"],
    ["landing page, referrer, timestamp", "Browser", "First-touch vs last-touch attribution"],
], [50 * mm, 34 * mm, 84 * mm])]))
A(P("These are opaque identifiers — they carry no personal data on their own. Their value is closing the loop: revenue "
    "attributed to the exact campaign, and conversions sent back so the platforms optimise correctly.", small))

# ── 3. Integration A: events API ────────────────────────────────────────────
A(P("3. Integration A — Events API (primary, already live)", h2))
A(P("Send every commerce and consent event to Retargetng. This is the only ingestion path needed for audiences to work.", body))

A(table([
    ["Endpoint", "<font face='Courier'>POST {BASE_URL}/api/v1/events</font>"],
    ["Auth", "<font face='Courier'>Authorization: Bearer aap_live_…</font> (create in Settings → API keys, scope <font face='Courier'>events:write</font>)"],
    ["Body", "A single event object, or an array of up to 1000 events"],
    ["Idempotency", "<font face='Courier'>event_id</font> must be unique and stable — retries and replays are ignored safely"],
    ["Response", "<font face='Courier'>{ accepted, duplicates, rejected: [{ index, event_id, errors[] }] }</font>"],
    ["Retries", "Retry on 5xx / network with exponential backoff. 4xx = fix the payload, do not retry"],
], [26 * mm, 142 * mm], header=False, zebra=False))

A(KeepTogether([P("3.1 Envelope (every event)", h3), Preformatted("""{
  "event_id":    "shopify-order-1042",          // unique + stable (idempotency key)
  "event_type":  "PURCHASE_COMPLETED",          // see list below
  "occurred_at": "2026-08-23T14:21:05+05:30",   // ISO-8601 with offset
  "source":      "shopify",                      // free text: store/app/system
  "customer": {                                  // at least one identifier required
    "external_customer_id": "cust_88431",
    "email":   "priya@example.com",
    "phone":   "+919876543210",
    "country": "IN"
  },
  "payload": { }                                 // shape depends on event_type
}""", code)]))

A(P("3.2 Event types and payloads", h3))
A(table([
    ["event_type", "payload"],
    ["CUSTOMER_CREATED / CUSTOMER_UPDATED",
     "<font face='Courier'>{ region?, city?, status?, source?, created_at?, attributes?: {k:v}, consent?: { marketing, advertising_personalization, data_sharing } }</font>"],
    ["PRODUCT_VIEWED", "<font face='Courier'>{ product: { external_product_id, name?, sku?, brand?, price?, external_category_id?, category_name? } }</font>"],
    ["ADD_TO_CART", "<font face='Courier'>{ cart_id?, product: {…}, quantity, value? }</font>"],
    ["CHECKOUT_STARTED", "<font face='Courier'>{ cart_id?, value? }</font>"],
    ["PURCHASE_COMPLETED", "<font face='Courier'>{ order: { external_order_id, total, subtotal?, discount?, currency?, cart_id?, items: [{ product, quantity, unit_price, total? }] } }</font>"],
    ["ORDER_CANCELLED", "<font face='Courier'>{ external_order_id }</font>"],
    ["ORDER_REFUNDED", "<font face='Courier'>{ external_order_id, amount?, partial? }</font>"],
    ["CONSENT_GRANTED / CONSENT_REVOKED", "<font face='Courier'>{ purposes: { marketing, advertising_personalization, data_sharing }, source?, legal_basis?, jurisdiction?, evidence? }</font>"],
    ["CUSTOMER_DELETED", "<font face='Courier'>{ reason? }</font>  → erases PII, suppresses everywhere"],
], [46 * mm, 122 * mm]))

A(KeepTogether([P("3.3 Worked example — purchase", h3), Preformatted("""curl -X POST https://YOUR-APP/api/v1/events \\
  -H "authorization: Bearer aap_live_xxx" -H "content-type: application/json" \\
  -d '[{
    "event_id": "order-1042", "event_type": "PURCHASE_COMPLETED",
    "occurred_at": "2026-08-23T14:21:05+05:30", "source": "shopify",
    "customer": { "external_customer_id": "cust_88431", "email": "priya@example.com",
                  "phone": "+919876543210", "country": "IN" },
    "payload": { "order": {
      "external_order_id": "1042", "total": 4999, "currency": "INR", "cart_id": "cart-A",
      "items": [{ "product": { "external_product_id": "SKU-RUN-12", "name": "Running Shoes",
                               "external_category_id": "footwear", "price": 4999 },
                  "quantity": 1, "unit_price": 4999 }] } }
  }]'""", code)]))

A(callout("Consent is mandatory", "Send CONSENT_GRANTED (or the <font face='Courier'>consent</font> block on the customer event) "
                                  "with the purposes the user actually agreed to. Without <font face='Courier'>advertising_personalization</font> "
                                  "and <font face='Courier'>data_sharing</font>, the customer is counted but never sent to Meta or Google.", NO))

# ── 4. Integration B: capture snippet ───────────────────────────────────────
A(P("4. Integration B — Click-ID capture snippet  <font size=8 color='#5b6172'>(PLANNED)</font>", h2))
A(P("A small first-party script on your site records the ad click identifiers and links them to the customer once they "
    "identify themselves. Nothing personal is collected before that point.", body))

A(KeepTogether([P("4.1 What the developer installs", h3), Preformatted("""<!-- once, before </body> on every page -->
<script async src="https://YOUR-APP/rt.js" data-site-key="rtk_live_xxx"></script>

<!-- on login / signup / checkout success, when the person is known -->
<script>
  window.rt('identify', {
    external_customer_id: 'cust_88431',
    email: 'priya@example.com',
    phone: '+919876543210'
  });
</script>""", code)]))

A(P("4.2 What it sends automatically", h3))
A(bullets([
    "<b>First-party visitor id</b> in a first-party cookie (<font face='Courier'>rt_vid</font>, 180 days) — no third-party cookies.",
    "<b>Click identifiers</b> from the landing URL: <font face='Courier'>fbclid, gclid, wbraid, gbraid, ttclid, msclkid</font> and all <font face='Courier'>utm_*</font> parameters.",
    "<b>Page context</b>: landing path, referrer, timestamp, first-touch and last-touch values.",
    "<b>Optional behaviour</b> if you prefer not to send it server-side: product views, add-to-cart, checkout start.",
], small))
A(P("Endpoint: <font face='Courier'>POST /api/v1/collect</font> (site key, no secret in the browser). On "
    "<font face='Courier'>identify</font> the anonymous visit history and click IDs are attached to the customer record.", small))

A(P("4.3 Platform-specific install notes", h3))
A(table([
    ["Platform", "How", "Effort"],
    ["Shopify", "Settings → Customer events → <b>Add custom pixel</b>, paste the snippet. Order/customer data comes from webhooks (below) — no theme edits.", "~10 min"],
    ["WooCommerce / WordPress", "Insert the script tag via your header plugin; hook <font face='Courier'>woocommerce_thankyou</font> for identify", "~30 min"],
    ["Custom site (Next.js, Rails, Laravel…)", "Script tag in the root layout; call <font face='Courier'>rt('identify', …)</font> after login/checkout", "~1 h"],
    ["Mobile app", "Post the same fields from the app (plus GAID/IDFA with consent) to <font face='Courier'>/api/v1/events</font>", "app release cycle"],
], [40 * mm, 108 * mm, 20 * mm]))

# ── 5. Integration C: webhooks ──────────────────────────────────────────────
A(P("5. Integration C — Store webhooks → events", h2))
A(P("Map your platform's webhooks to the event types in §3.2. This is the reliable server-side source of truth; the "
    "browser snippet is only for click IDs and optional behaviour.", body))
A(table([
    ["Your webhook", "Send as"],
    ["customers/create, customers/update", "CUSTOMER_CREATED / CUSTOMER_UPDATED (include the consent block)"],
    ["carts/update, checkouts/create", "ADD_TO_CART / CHECKOUT_STARTED"],
    ["orders/create (or paid)", "PURCHASE_COMPLETED"],
    ["orders/cancelled", "ORDER_CANCELLED"],
    ["refunds/create", "ORDER_REFUNDED"],
    ["customers/data_erasure, GDPR/DPDP delete", "CUSTOMER_DELETED"],
    ["marketing consent change / unsubscribe", "CONSENT_REVOKED"],
], [62 * mm, 106 * mm]))
A(P("Use the platform's own object id in <font face='Courier'>event_id</font> (e.g. <font face='Courier'>shopify-order-1042</font>) so "
    "webhook retries are naturally idempotent.", small))

# ── 6. Conversions back-channel ─────────────────────────────────────────────
A(P("6. Integration D — Conversions back-channel  <font size=8 color='#5b6172'>(PLANNED)</font>", h2))
A(P("Purchases are sent <i>back</i> to the ad platforms with hashed identifiers and the original click ID. This is what "
    "makes the platforms optimise properly and what raises reported match and attribution quality.", body))
A(table([
    ["Platform", "Mechanism", "What we send", "You provide"],
    ["Meta", "Conversions API (server-side)", "event_name, event_time, event_id (dedup with your pixel), hashed em/ph/fn/ln/ct/st/zp/country/db/ge, external_id, fbc (from fbclid), fbp, client IP + user agent, value + currency", "System-user access token, Pixel/Dataset ID, ad account"],
    ["Google", "Enhanced Conversions / offline conversion import", "gclid (or wbraid/gbraid), conversion action, time, value, hashed email/phone/name/address", "OAuth client + refresh token, developer token, conversion action id"],
], [22 * mm, 40 * mm, 74 * mm, 32 * mm]))
A(Spacer(1, 2 * mm))
A(callout("De-duplication", "If you keep the Meta Pixel on the site, the browser event and the server event must share the same "
                            "<font face='Courier'>event_id</font> so Meta counts one conversion, not two. Retargetng generates and stores that id — "
                            "pass it to the pixel call.", ACCENT))

# ── 7. Lead ads ─────────────────────────────────────────────────────────────
A(P("7. Integration E — Lead Ads  <font size=8 color='#5b6172'>(PLANNED, only if you run lead-gen ads)</font>", h2))
A(bullets([
    "<b>Meta:</b> subscribe a webhook to the <font face='Courier'>leadgen</font> field on your Page; on each notification we fetch the lead "
    "via the Graph API and create a customer with the consent captured on the form.",
    "<b>Google:</b> configure the lead-form extension webhook (URL + key); the payload is posted directly to us.",
    "Requires: a Meta app with <font face='Courier'>leads_retrieval</font> + <font face='Courier'>pages_manage_ads</font>, and Page admin approval.",
], small))

# ── 8. Hashing / normalisation ──────────────────────────────────────────────
A(P("8. Normalisation &amp; hashing (handled by Retargetng — for your reference)", h2))
A(P("Send raw values; the platform normalises and hashes them per destination, stores only the hashes for activation, and "
    "encrypts the raw values at rest (AES-256-GCM). Raw PII never appears in logs, exports or the dashboard.", body))
A(table([
    ["Field", "Meta", "Google"],
    ["Email", "trim, lowercase → SHA-256 hex", "trim, lowercase; for gmail/googlemail remove dots and +suffix → SHA-256 hex"],
    ["Phone", "digits only with country code, no '+' → SHA-256 hex", "E.164 with '+' → SHA-256 hex"],
    ["Name / city / state", "lowercase, strip punctuation → SHA-256", "lowercase, strip whitespace → SHA-256"],
    ["Postal code / country", "first 5 chars / ISO-2, lowercase → SHA-256", "as provided → SHA-256"],
], [26 * mm, 62 * mm, 80 * mm]))

# ── 9. Phasing ──────────────────────────────────────────────────────────────
A(P("9. Suggested order of work", h2))
A(table([
    ["#", "Deliverable", "Owner", "Effort"],
    ["1", "Extra match keys included in the customer feed (name, city, state, PIN, country)", "Your dev + Retargetng", "0.5 day"],
    ["2", "Store webhooks → <font face='Courier'>/api/v1/events</font> (customers, carts, orders, refunds, consent)", "Your dev", "0.5–1 day"],
    ["3", "Capture snippet + <font face='Courier'>identify()</font> on login/checkout (click IDs, stitching)", "Your dev (10 min) + Retargetng (1 day)", "1 day"],
    ["4", "Conversions back-channel to Meta + Google (with dedup)", "Retargetng, needs your tokens", "1–2 days"],
    ["5", "Lead Ads ingestion", "Retargetng + your Meta app approval", "1 day"],
    ["6", "App SDK events + GAID/IDFA with ATT consent", "Your mobile dev", "app release"],
], [8 * mm, 84 * mm, 46 * mm, 30 * mm]))

# ── 10. Checklist ───────────────────────────────────────────────────────────
A(P("10. What we need from you to start", h2))
A(bullets([
    "Storefront platform and stack (Shopify / WooCommerce / custom — framework and language).",
    "Whether a mobile app exists (decides if device IDs are in scope at all).",
    "Whether you run lead-generation ads with on-platform forms.",
    "Where consent is captured today (checkout tick-box, preference centre, WhatsApp opt-in) and whether it is stored per purpose.",
    "A sample export of 20 customer rows and 20 order rows (headers + dummy values) so field mapping can be finalised.",
    "For the live back-channel: Meta system-user token + pixel/dataset id, Google OAuth credentials + developer token.",
], small))
A(Spacer(1, 4 * mm))
A(callout("Non-negotiables", "No scraping, no purchased lists, no fingerprinting, no de-anonymisation, and no upload of anyone "
                             "who opted out. Every activation passes the consent gate; suppression and deletion propagate to every "
                             "destination automatically.", NO))


def decorate(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(21 * mm, 285 * mm, 189 * mm, 285 * mm)
    canvas.setFont("Helvetica", 7.4)
    canvas.setFillColor(MUTED)
    canvas.drawString(21 * mm, 288 * mm, "Retargetng — Data Capture & Integration Specification")
    canvas.drawRightString(189 * mm, 288 * mm, "Confidential — for the implementing developer")
    canvas.line(21 * mm, 16 * mm, 189 * mm, 16 * mm)
    canvas.drawString(21 * mm, 11 * mm, "v1.0")
    canvas.drawCentredString(105 * mm, 11 * mm, "First-party data only · consent enforced in code")
    canvas.drawRightString(189 * mm, 11 * mm, f"Page {doc.page}")
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=21 * mm, rightMargin=21 * mm,
                      topMargin=22 * mm, bottomMargin=20 * mm,
                      title="Retargetng — Data Capture & Integration Specification",
                      author="Retargetng", subject="Developer integration specification")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=decorate)])
doc.build(story)
print("wrote", OUT)
