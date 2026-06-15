import Link from 'next/link';
import { EyeOff, Smartphone, Sparkles, Clock } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-brand-ivory text-brand-ink antialiased">
      {/* Sticky nav */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-brand-ivory/80 backdrop-blur-md border-b border-brand-ink/5">
        <div className="max-w-6xl mx-auto px-6 md:px-10 h-16 flex items-center justify-between">
          <Link href="/" className="font-display text-xl font-semibold text-brand-deep-saffron tracking-tight">
            Swara
          </Link>
          <nav className="hidden md:flex items-center gap-8 text-sm text-brand-stone">
            <a href="#how-it-works" className="hover:text-brand-deep-saffron transition-colors">How it works</a>
            <a href="#features" className="hover:text-brand-deep-saffron transition-colors">Features</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-brand-stone hover:text-brand-ink px-4 py-2 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="text-sm bg-brand-deep-saffron text-white px-5 py-2 rounded-full hover:opacity-90 transition-all duration-300 font-medium"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section
          className="relative pt-40 pb-24 md:pt-48 md:pb-32 px-6 md:px-10"
          style={{
            backgroundImage:
              'radial-gradient(ellipse at 50% 0%, rgba(217,119,6,0.06), transparent 60%)',
          }}
        >
          <div className="max-w-5xl mx-auto flex flex-col items-center text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-brand-deep-saffron font-medium mb-6">
              Tribute videos, reimagined
            </p>
            <h1 className="font-display text-5xl md:text-6xl lg:text-7xl text-brand-ink font-semibold tracking-tight leading-[1.05] max-w-4xl mb-6">
              Turn every memory
              <br />
              <span className="text-brand-deep-saffron italic">into magic</span>
            </h1>
            <p className="text-lg md:text-xl text-brand-stone max-w-2xl mb-10 leading-relaxed">
              Collect heartfelt messages from friends and family. We craft them into a beautiful tribute video, ready to present on the big day.
            </p>
            <div className="flex flex-col sm:flex-row items-center gap-4 mb-20">
              <Link
                href="/login"
                className="px-8 py-4 bg-brand-deep-saffron text-white rounded-full text-sm font-medium shadow-lg shadow-brand-deep-saffron/20 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300"
              >
                Create a tribute
              </Link>
              <a
                href="#how-it-works"
                className="text-sm text-brand-stone hover:text-brand-deep-saffron transition-colors flex items-center gap-2 px-4 py-3"
              >
                See how it works
                <span aria-hidden>→</span>
              </a>
            </div>

            {/* Stat strip */}
            <div className="w-full max-w-3xl bg-white border border-brand-ink/8 rounded-3xl px-6 py-7 shadow-sm flex flex-col md:flex-row items-center justify-around gap-6 md:gap-4">
              <div className="text-center">
                <p className="font-display text-2xl font-semibold text-brand-deep-saffron">Birthdays · Graduations</p>
                <p className="text-xs uppercase tracking-widest text-brand-stone/70 mt-1.5">Occasions celebrated</p>
              </div>
              <div className="hidden md:block w-px h-12 bg-brand-ink/10" />
              <div className="text-center">
                <p className="font-display text-2xl font-semibold text-brand-deep-saffron">Before the day</p>
                <p className="text-xs uppercase tracking-widest text-brand-stone/70 mt-1.5">Delivery promise</p>
              </div>
              <div className="hidden md:block w-px h-12 bg-brand-ink/10" />
              <div className="text-center">
                <p className="font-display text-2xl font-semibold text-brand-deep-saffron">Unlimited</p>
                <p className="text-xs uppercase tracking-widest text-brand-stone/70 mt-1.5">Contributors included</p>
              </div>
            </div>
          </div>
        </section>

        {/* How it works — twilight */}
        <section id="how-it-works" className="py-24 md:py-28 px-6 md:px-10 bg-brand-twilight text-white relative overflow-hidden">
          <div className="max-w-5xl mx-auto relative z-10">
            <div className="mb-16 md:mb-20 text-center md:text-left">
              <span className="text-xs uppercase tracking-[0.2em] text-brand-gold-accent font-medium mb-4 block">
                Simple by design
              </span>
              <h2 className="font-display text-4xl md:text-5xl font-semibold leading-tight">
                How it works
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
              {[
                { step: '01', title: 'Create an event', body: 'Tell us about the occasion in under a minute. Pick a theme, a date, and you\'re ready.' },
                { step: '02', title: 'Invite contributors', body: 'Share one private link. Friends, family, or colleagues record clips, voice notes, or write messages right from their phones.' },
                { step: '03', title: 'We deliver before the day', body: 'An AI-assisted cinematic edit, polished by humans, lands in your inbox ahead of the occasion.' },
              ].map(({ step, title, body }) => (
                <div key={step} className="group">
                  <p className="font-display text-6xl md:text-7xl font-semibold text-white/15 mb-4 group-hover:text-brand-gold-accent/40 transition-colors duration-500">
                    {step}
                  </p>
                  <h3 className="font-display text-xl font-semibold mb-3">{title}</h3>
                  <p className="text-white/70 leading-relaxed text-sm">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features — ivory */}
        <section id="features" className="py-24 md:py-28 px-6 md:px-10">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-16 md:mb-20">
              <span className="text-xs uppercase tracking-[0.2em] text-brand-deep-saffron font-medium mb-4 block">
                Why Swara Magical
              </span>
              <h2 className="font-display text-4xl md:text-5xl text-brand-ink font-semibold leading-tight">
                Every detail, handled
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {[
                { Icon: EyeOff, title: 'Surprise-proof', body: 'The honoree never sees a thing. Submissions are private and the page is unlisted — the magic stays intact until you choose to reveal it.' },
                { Icon: Smartphone, title: 'No tech needed', body: 'Contributors open a link, record or type their message, and submit. That\'s it — no accounts, no installs, no friction.' },
                { Icon: Sparkles, title: 'AI-assisted editing', body: 'Our AI analyzes every submission for tone, pacing, and highlights — so the final edit feels personal, not generic.' },
                { Icon: Clock, title: 'Delivered on time', body: 'We work to your deadline. Set your event date and we make sure the video is in your hands before the occasion — not after.' },
              ].map(({ Icon, title, body }) => (
                <div
                  key={title}
                  className="group relative overflow-hidden bg-white border border-brand-ink/8 rounded-2xl p-8 shadow-sm hover:shadow-md transition-all duration-300"
                >
                  <div className="absolute top-0 left-0 w-full h-1 bg-brand-deep-saffron -translate-x-full group-hover:translate-x-0 transition-transform duration-500" />
                  <div className="mb-5 w-11 h-11 bg-brand-deep-saffron/10 rounded-xl flex items-center justify-center text-brand-deep-saffron">
                    <Icon size={20} strokeWidth={1.75} />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-brand-ink mb-2">{title}</h3>
                  <p className="text-sm text-brand-stone leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20 md:py-24 px-6 md:px-10 bg-brand-rose-gold/10 border-y border-brand-rose-gold/20">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="font-display text-4xl md:text-5xl text-brand-ink font-semibold mb-4 leading-tight">
              Ready to create something unforgettable?
            </h2>
            <p className="text-brand-stone mb-10 text-lg">
              It starts with one event. The magic takes care of the rest.
            </p>
            <Link
              href="/login"
              className="inline-block bg-brand-deep-saffron text-white text-sm font-medium px-10 py-4 rounded-full shadow-xl shadow-brand-deep-saffron/20 hover:shadow-2xl hover:-translate-y-0.5 transition-all duration-300"
            >
              Get started
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="py-12 px-6 md:px-10 border-t border-brand-ink/8 bg-brand-ivory">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="text-center md:text-left">
            <p className="font-display text-lg font-semibold text-brand-deep-saffron">Swara</p>
            <p className="text-xs text-brand-stone/70 mt-1">by Swara Media</p>
          </div>
          <div className="flex items-center gap-8 text-sm text-brand-stone/70">
            <Link href="/login" className="hover:text-brand-ink transition-colors">Sign in</Link>
            <Link href="/login" className="hover:text-brand-ink transition-colors">Create event</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
