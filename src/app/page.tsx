import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-brand-ivory">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-brand-ivory/90 backdrop-blur-sm border-b border-brand-ink/5">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="font-display text-xl font-semibold">
            <span className="text-brand-deep-saffron">Swara</span>
            <span className="text-brand-ink ml-1 font-light">Magical</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-brand-ink/70 hover:text-brand-ink px-4 py-2 transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="/login"
              className="text-sm bg-brand-deep-saffron text-white px-5 py-2 rounded-full hover:bg-amber-600 transition-colors font-medium"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-40 pb-24 px-6 text-center">
        <div className="max-w-3xl mx-auto">
          <p className="text-xs uppercase tracking-widest text-brand-deep-saffron font-medium mb-6">
            Tribute Videos, Reimagined
          </p>
          <h1 className="font-display text-5xl md:text-6xl lg:text-7xl text-brand-ink font-semibold tracking-tight leading-tight">
            Turn Every Memory
            <br />
            <span className="text-brand-deep-saffron">Into Magic</span>
          </h1>
          <p className="mt-6 text-lg md:text-xl text-brand-ink/60 max-w-xl mx-auto leading-relaxed">
            Collect heartfelt messages from friends and family. We craft them into a beautiful tribute video — ready to present on the big day.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/login"
              className="bg-brand-deep-saffron text-white text-base px-8 py-3.5 rounded-full hover:bg-amber-600 transition-colors font-medium shadow-sm"
            >
              Create a Tribute
            </Link>
            <a
              href="#how-it-works"
              className="text-base text-brand-ink/70 hover:text-brand-ink px-6 py-3.5 transition-colors"
            >
              See how it works ↓
            </a>
          </div>
        </div>

        {/* Decorative band */}
        <div className="mt-20 max-w-4xl mx-auto grid grid-cols-3 gap-px rounded-2xl overflow-hidden shadow-sm border border-brand-ink/8">
          {[
            { label: 'Occasions', value: 'Birthdays · Graduations · Retirements · Corporate Milestones & More' },
            { label: 'Delivery', value: 'Before your occasion — ready to present on the day' },
            { label: 'Contributors', value: 'Unlimited · No app needed' },
          ].map(({ label, value }) => (
            <div key={label} className="bg-white px-6 py-5 text-center">
              <p className="text-xs uppercase tracking-widest text-brand-ink/40 mb-1">{label}</p>
              <p className="text-sm text-brand-ink/80 font-medium">{value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-24 px-6 bg-brand-twilight text-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-xs uppercase tracking-widest text-brand-gold-accent mb-3">Simple by Design</p>
            <h2 className="font-display text-4xl md:text-5xl font-semibold">How It Works</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-10">
            {[
              {
                step: '01',
                title: 'Create an Event',
                body: 'Tell us about the occasion — a birthday, graduation, retirement, corporate milestone, or any celebration worth commemorating.',
              },
              {
                step: '02',
                title: 'Invite Contributors',
                body: 'Share a private link. Friends, family, or colleagues submit video clips, voice notes, photos, or written messages — no account needed.',
              },
              {
                step: '03',
                title: 'We Deliver Before the Day',
                body: 'Our team crafts a polished tribute video and delivers it to you ahead of the occasion — so you can present it at the perfect moment.',
              },
            ].map(({ step, title, body }) => (
              <div key={step} className="relative">
                <p className="font-display text-5xl font-semibold text-white/10 mb-4">{step}</p>
                <h3 className="font-display text-xl font-semibold mb-3">{title}</h3>
                <p className="text-white/60 leading-relaxed text-sm">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why Swara */}
      <section className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-xs uppercase tracking-widest text-brand-deep-saffron mb-3">Why Swara Magical</p>
            <h2 className="font-display text-4xl md:text-5xl text-brand-ink font-semibold">
              Every Detail, Handled
            </h2>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              {
                title: 'Surprise-Proof',
                body: 'The honoree never sees a thing. Submissions are private and the page is unlisted — the magic stays intact until you choose to reveal it.',
              },
              {
                title: 'No Tech Needed',
                body: 'Contributors open a link, record or type their message, and submit. That\'s it — no accounts, no installs, no friction.',
              },
              {
                title: 'AI-Assisted Editing',
                body: 'Our AI analyzes every submission for tone, pacing, and highlights — so the final edit feels personal, not generic.',
              },
              {
                title: 'Delivered on Time',
                body: 'We work to your deadline. Set your event date and we make sure the video is in your hands before the occasion — not after.',
              },
            ].map(({ title, body }) => (
              <div key={title} className="bg-white rounded-2xl p-8 border border-brand-ink/6 hover:shadow-md transition-shadow">
                <div className="w-8 h-1 bg-brand-deep-saffron rounded-full mb-4" />
                <h3 className="font-display text-lg font-semibold text-brand-ink mb-2">{title}</h3>
                <p className="text-sm text-brand-ink/60 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="py-20 px-6 bg-brand-rose-gold/10 border-y border-brand-rose-gold/20">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="font-display text-4xl md:text-5xl text-brand-ink font-semibold mb-4">
            Ready to create something unforgettable?
          </h2>
          <p className="text-brand-ink/60 mb-8 text-lg">
            It starts with one event. The magic takes care of the rest.
          </p>
          <Link
            href="/login"
            className="inline-block bg-brand-deep-saffron text-white text-base px-10 py-4 rounded-full hover:bg-amber-600 transition-colors font-medium shadow-sm"
          >
            Get Started — it&apos;s free to set up
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 px-6 border-t border-brand-ink/8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="font-display text-lg font-semibold">
            <span className="text-brand-deep-saffron">Swara</span>
            <span className="text-brand-ink ml-1 font-light">Magical</span>
          </div>
          <p className="text-xs text-brand-ink/40 uppercase tracking-widest">by Swara Media</p>
          <div className="flex items-center gap-6">
            <Link href="/login" className="text-sm text-brand-ink/50 hover:text-brand-ink transition-colors">
              Sign In
            </Link>
            <Link href="/login" className="text-sm text-brand-ink/50 hover:text-brand-ink transition-colors">
              Create Event
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
