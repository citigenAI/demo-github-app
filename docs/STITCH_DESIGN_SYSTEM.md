# Stitch-generated design system
## name: Tribute & Legacy
## asset id: assets/58d9cf995ad64503aaf81dfac6496449
## guidelines (truncated):
## Brand & Style

This design system is crafted for a service that transforms memories into cinematic tributes. The brand personality is deeply empathetic, celebratory, and premium. It balances the solemnity of remembrance with the warmth of a life well-lived.

The visual style leans into **Minimalism with a Tactile touch**. It utilizes generous white space to allow photography and video content to breathe, paired with elegant editorial typography. The interface avoids cold, purely functional layouts in favor of a "digital heirloom" aesthetic—soft edges, subtle transitions, and high-quality finishes that feel intentional and respectful.

## Layout & Spacing

This design system uses a **Fluid Grid** with generous padding to create a sense of calm. 

- **Desktop:** 12-column grid with 64px side margins. The wide margins prevent the UI from feeling "crowded" by the edges of the browser.
- **Mobile:** 4-column grid with 20px margins.
- **Spacing Rhythm:** Based on an 8px scale. Use large `section-gap` values (80px+) to separate different phases of the user journey (e.g., from "How it works" to "Pricing").
- **Navbar:** The navigation bar is semi-transparent with a backdrop-blur (12px) to maintain a light, airy feel as the user scrolls through imagery.

## Elevation & Depth

Visual hierarchy is established through **Tonal Layers** rather than heavy shadows.

- **Surface Tiers:** The base layer is Ivory (#FAF7F0). Elevated cards or modals use a pure white surface with a very soft, diffused shadow (15% opacity of Twilight #3B3169) to lift them gently from the background.
- **Transparency:** Use semi-transparent overlays for navigation and secondary UI panels to maintain a connection with the media content beneath.
- **Glassmorphism:** Applied sparingly to overlays on top of video or high-resolution images to maintain legibility without obscuring the visual memory.

## Components

- **Buttons:** Primary buttons use a solid Saffron (#D97706) fill with white text. Secondary buttons use an Ivory fill with a thin Twilight (#3B3169) border. All button text is sentence-case.
- **Input Fields:** Minimal styling with a 1px border in Twilight (at 20% opacity). On focus, the border transitions to Saffron with a soft glow.
- **Cards:** Cards should have a subtle border-radius (1rem) and a slight Twilight-tinted shadow. Use "Media Cards" to prioritize photography, with text overlays at the bottom using a gradient scrim for legibility.
- **Chips:** Used for "Memory Tags" (e.g., #Family, #Adventure). These should be pill-shaped with a light Gold (#E8C547) background and dark text.
- **Tribute Timeline:** A specialized component using a vertical line in Twilight with Gold "nodes" to represent key life events in the video creation process.
