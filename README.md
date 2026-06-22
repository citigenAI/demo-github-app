# Homemade Cake Studio

A simple mobile-friendly PWA for your aunt to sell cakes. Customers browse the catalog, tap to add cakes to an order, then send the order via WhatsApp.

## How to use it

1. Open `index.html` in a browser. For full PWA + service worker support, serve it over HTTP (e.g. `python -m http.server 8000` in this folder, then visit http://localhost:8000).
2. On a phone, "Add to Home Screen" installs it like an app.

## Things to customize

- **WhatsApp number**: open `app.js`, change `WHATSAPP_NUMBER` to your aunt's number, digits only with country code (e.g. `14155551234` for +1 415 555 1234).
- **Cakes**: edit the `CAKES` array in `app.js`. Each entry has `id`, `name`, `price`, `emoji`, `bg` (background color), and `desc`.
- **Shop name / tagline**: in `index.html`, inside the `<header class="hero">` block.
- **Colors**: in `styles.css`, the `:root` block at the top.

## Interaction

- Tap a cake to add one to the order.
- Right-click (or long-press on mobile) to remove one.
- "Send Order on WhatsApp" opens WhatsApp with a pre-filled order message.
