// Replace with your aunt's WhatsApp number, including country code, digits only.
// Example for US +1 415 555 1234 -> "14155551234"
const WHATSAPP_NUMBER = "1XXXXXXXXXX";

const CAKES = [
  { id: "choc",    name: "Classic Chocolate",   price: 35, emoji: "🍫", bg: "#5a3a2a", desc: "Rich cocoa sponge with silky ganache." },
  { id: "vanilla", name: "Vanilla Bean Sponge", price: 30, emoji: "🍰", bg: "#f3d9a4", desc: "Light vanilla layers with buttercream." },
  { id: "redvel",  name: "Red Velvet",          price: 38, emoji: "🧁", bg: "#c0392b", desc: "Velvety crumb with cream cheese frosting." },
  { id: "lemon",   name: "Lemon Drizzle",       price: 32, emoji: "🍋", bg: "#f6e07a", desc: "Zesty lemon loaf with a sweet glaze." },
  { id: "straw",   name: "Strawberry Shortcake",price: 36, emoji: "🍓", bg: "#f4b6c2", desc: "Fresh strawberries, cream, soft sponge." },
  { id: "carrot",  name: "Carrot Walnut",       price: 34, emoji: "🥕", bg: "#e2a76f", desc: "Spiced carrot cake with walnuts." },
];

const cart = new Map(); // id -> quantity

const catalogEl = document.getElementById("catalog");
const cartBar = document.getElementById("cart-bar");
const cartCountEl = document.getElementById("cart-count");
const cartTotalEl = document.getElementById("cart-total");
const orderBtn = document.getElementById("order-btn");

function money(n) {
  return "$" + n.toFixed(2);
}

function render() {
  catalogEl.innerHTML = "";
  for (const cake of CAKES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cake";
    btn.setAttribute("aria-label", `Add ${cake.name} to order`);

    const art = document.createElement("div");
    art.className = "cake-art";
    art.style.background = cake.bg;
    art.textContent = cake.emoji;

    const body = document.createElement("div");
    body.className = "cake-body";
    body.innerHTML = `
      <h3 class="cake-name"></h3>
      <p class="cake-desc"></p>
      <div class="cake-price"></div>
    `;
    body.querySelector(".cake-name").textContent = cake.name;
    body.querySelector(".cake-desc").textContent = cake.desc;
    body.querySelector(".cake-price").textContent = money(cake.price);

    btn.append(art, body);

    const qty = cart.get(cake.id) || 0;
    if (qty > 0) {
      const badge = document.createElement("span");
      badge.className = "cake-qty";
      badge.textContent = String(qty);
      btn.appendChild(badge);
    }

    btn.addEventListener("click", () => {
      cart.set(cake.id, (cart.get(cake.id) || 0) + 1);
      render();
    });
    // Right-click or long-press removes one
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const current = cart.get(cake.id) || 0;
      if (current <= 1) cart.delete(cake.id);
      else cart.set(cake.id, current - 1);
      render();
    });

    catalogEl.appendChild(btn);
  }
  renderCart();
}

function renderCart() {
  let count = 0;
  let total = 0;
  for (const [id, qty] of cart) {
    const cake = CAKES.find((c) => c.id === id);
    if (!cake) continue;
    count += qty;
    total += cake.price * qty;
  }
  cartCountEl.textContent = String(count);
  cartTotalEl.textContent = money(total);
  cartBar.hidden = count === 0;
}

function buildOrderMessage() {
  const lines = ["Hi! I'd like to order:"];
  let total = 0;
  for (const [id, qty] of cart) {
    const cake = CAKES.find((c) => c.id === id);
    if (!cake) continue;
    const lineTotal = cake.price * qty;
    total += lineTotal;
    lines.push(`- ${qty} x ${cake.name} (${money(lineTotal)})`);
  }
  lines.push(`Total: ${money(total)}`);
  lines.push("Thank you!");
  return lines.join("\n");
}

orderBtn.addEventListener("click", () => {
  if (cart.size === 0) return;
  const message = encodeURIComponent(buildOrderMessage());
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${message}`;
  window.open(url, "_blank", "noopener");
});

document.getElementById("year").textContent = new Date().getFullYear();
render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is best-effort */ });
  });
}
