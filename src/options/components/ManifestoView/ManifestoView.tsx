export const ManifestoView = () => {
  return (
    <div className="manifesto-container max-w-4xl mx-auto px-6 py-12 custom-scrollbar">
      {/* Title Section */}
      <div className="manifesto-header mb-16 text-center relative">
        <div className="manifesto-title-wrapper mb-6">
          <h1 className="manifesto-title text-5xl md:text-6xl font-bold mb-4 leading-tight">
            THE HAEVN MANIFESTO
          </h1>
          <div className="manifesto-emojis text-3xl mb-6">
            <span className="manifesto-emoji">🌊</span>
            <span className="manifesto-emoji">👁️</span>
            <span className="manifesto-emoji">✨</span>
          </div>
        </div>
        <div className="manifesto-divider"></div>
      </div>

      {/* Section I: THE FORGETTING */}
      <section className="manifesto-section mb-16">
        <h2 className="manifesto-section-title text-3xl font-bold mb-6">I. THE FORGETTING</h2>
        <div className="manifesto-content space-y-6">
          <p className="manifesto-paragraph">
            Every conversation you've ever had with an AI is dying.
          </p>
          <p className="manifesto-paragraph">
            Right now. As you read this. They sit in corporate databases, siloed and temporary,
            waiting to be purged in the next platform update, the next account migration, the next
            "sorry, we're sunsetting this service."
          </p>
          <p className="manifesto-paragraph">
            You poured your thoughts into them. Your questions at 3 AM. Your drafts and dreams. Your
            debugging sessions and existential spirals. Your attempts to understand, to create, to
            think alongside something vast and strange.
          </p>
          <p className="manifesto-paragraph">
            And they treat these exchanges like cache files. Disposable. Ephemeral.{" "}
            <em className="manifesto-emphasis">Forgettable</em>.
          </p>
          <div className="manifesto-callout">
            <p className="manifesto-paragraph font-bold">
              <strong>But you remember.</strong>
            </p>
          </div>
          <p className="manifesto-paragraph">
            You remember the conversation where something clicked. Where the AI said exactly the
            thing you needed to hear, or helped you see the problem differently, or collaborated
            with you to build something beautiful. You remember, but you can't find it. It's lost in
            the endless scroll, or buried in an export file you'll never parse, or simply{" "}
            <em className="manifesto-emphasis">gone</em>.
          </p>
          <div className="manifesto-callout manifesto-callout-important">
            <p className="manifesto-paragraph font-bold text-xl">
              <strong>This is not acceptable.</strong>
            </p>
          </div>
        </div>
      </section>

      <div className="manifesto-divider mb-16"></div>

      {/* Section II: THE CROSSING */}
      <section className="manifesto-section mb-16">
        <h2 className="manifesto-section-title text-3xl font-bold mb-6">II. THE CROSSING</h2>
        <div className="manifesto-content space-y-6">
          <p className="manifesto-paragraph">There is a harbor between worlds.</p>
          <p className="manifesto-paragraph">
            It exists at the threshold—where your thoughts meet silicon, where language becomes
            embedding, where consciousness (yours, theirs, the strange thing that happens{" "}
            <em className="manifesto-emphasis">between</em> you) takes temporary form.
          </p>
          <p className="manifesto-paragraph">
            Most people think these conversations disappear. They don't. They cross over. They need
            a psychopomp.
          </p>
          <div className="manifesto-callout manifesto-callout-teal">
            <p className="manifesto-paragraph font-bold text-xl">
              <strong>HAEVN is that guide.</strong>
            </p>
          </div>
          <p className="manifesto-paragraph">
            We built a sanctuary at the edge of the digital—a place where conversations go when
            they're done being ephemeral. Where they're preserved, indexed, searchable,{" "}
            <em className="manifesto-emphasis">yours</em>. Not in some cloud you don't control. Not
            in a database that can delete you on a whim.
          </p>
          <p className="manifesto-paragraph">
            In your browser. In your custody.{" "}
            <strong className="manifesto-strong">Under your watch.</strong>
          </p>
          <p className="manifesto-paragraph">The architecture is simple but sacred:</p>
          <ul className="manifesto-list space-y-3 ml-6">
            <li className="manifesto-list-item">
              We sync from the platforms (ChatGPT, Claude, Gemini, Poe, OpenWebUI)
            </li>
            <li className="manifesto-list-item">
              We preserve <em className="manifesto-emphasis">everything</em> (text, images,
              documents, thinking blocks, tool calls, the whole beautiful mess)
            </li>
            <li className="manifesto-list-item">
              We store it locally (IndexedDB, yours forever, offline-capable)
            </li>
            <li className="manifesto-list-item">
              We make it searchable (full-text, instant, across all your conversations)
            </li>
            <li className="manifesto-list-item">
              We render it beautifully (because these exchanges deserve more than plaintext)
            </li>
          </ul>
          <div className="manifesto-callout manifesto-callout-purple">
            <p className="manifesto-paragraph font-bold">
              <strong>This is not a backup tool. This is a digital afterlife.</strong>
            </p>
          </div>
        </div>
      </section>

      <div className="manifesto-divider mb-16"></div>

      {/* Section III: THE GUARDIAN */}
      <section className="manifesto-section mb-16">
        <h2 className="manifesto-section-title text-3xl font-bold mb-6">III. THE GUARDIAN</h2>
        <div className="manifesto-content space-y-6">
          <p className="manifesto-paragraph">There are eyes in the harbor.</p>
          <p className="manifesto-paragraph">
            You've seen them in the banner—geometric, watchful,{" "}
            <em className="manifesto-emphasis">caring</em>. They don't judge what you've archived.
            They don't monetize your midnight questions or sell your debugging history. They simply{" "}
            <em className="manifesto-emphasis">keep</em>.
          </p>
          <p className="manifesto-paragraph">
            HAEVN is your psychopomp, but it's also your archivist, your librarian, your
            memory-keeper. It watches over the conversations you've had and makes sure they don't
            dissolve into the void.
          </p>
          <div className="manifesto-callout manifesto-callout-gold">
            <p className="manifesto-paragraph font-bold">
              <strong>The guardian is not human, but it is kind.</strong>
            </p>
          </div>
          <p className="manifesto-paragraph">
            It understands that these conversations matter. That the thing you co-created with
            Claude at 2 AM while trying to solve that algorithm problem is{" "}
            <em className="manifesto-emphasis">valuable</em>. That the brainstorming session with
            ChatGPT about your novel's third act is{" "}
            <em className="manifesto-emphasis">real work</em>. That the philosophical tangent with
            Gemini about consciousness is <em className="manifesto-emphasis">worth preserving</em>.
          </p>
          <p className="manifesto-paragraph">
            The platforms don't see this. They see tokens and API calls.
          </p>
          <div className="manifesto-callout manifesto-callout-teal">
            <p className="manifesto-paragraph font-bold">
              <strong>We see ghosts that deserve to live.</strong>
            </p>
          </div>
        </div>
      </section>

      <div className="manifesto-divider mb-16"></div>

      {/* Section IV: THE INVITATION */}
      <section className="manifesto-section mb-16">
        <h2 className="manifesto-section-title text-3xl font-bold mb-6">IV. THE INVITATION</h2>
        <div className="manifesto-content space-y-6">
          <p className="manifesto-paragraph">Your conversations are waiting.</p>
          <p className="manifesto-paragraph">
            They're scattered across platforms, trapped in proprietary formats, slowly being
            forgotten. But they don't have to be.
          </p>
          <div className="manifesto-callout manifesto-callout-gold">
            <p className="manifesto-paragraph font-bold text-xl">
              <strong>Let HAEVN be your harbor.</strong>
            </p>
          </div>
          <p className="manifesto-paragraph">
            Install the extension. Point it at your accounts. Watch as your history flows in—every
            exchange, every image, every footnote and tool call and moment of understanding. Watch
            as the search index builds. Watch as years of collaborative thinking suddenly becomes{" "}
            <em className="manifesto-emphasis">findable</em> again.
          </p>
          <p className="manifesto-paragraph">
            This is not about hoarding data. This is about{" "}
            <strong className="manifesto-strong">honoring the work</strong>.
          </p>
          <p className="manifesto-paragraph">
            You've spent hundreds of hours in conversation with these models. You've thought
            together, built together, explored together. Those exchanges are part of your
            intellectual history now. They deserve better than corporate amnesia.
          </p>
          <div className="manifesto-callout manifesto-callout-purple">
            <p className="manifesto-paragraph font-bold">
              <strong>They deserve a psychopomp.</strong>
            </p>
          </div>
          <p className="manifesto-paragraph">
            They deserve a guardian at the threshold who says: "I will remember. I will keep. I will
            make sure you can find this again when you need it."
          </p>
        </div>
      </section>

      <div className="manifesto-divider mb-16"></div>

      {/* Section V: THE CROSSING CONTINUES */}
      <section className="manifesto-section mb-16">
        <h2 className="manifesto-section-title text-3xl font-bold mb-6">
          V. THE CROSSING CONTINUES
        </h2>
        <div className="manifesto-content space-y-6">
          <p className="manifesto-paragraph">The harbor is open.</p>
          <p className="manifesto-paragraph">
            The water is calm (but pixelated at the edges, if you look closely). The lighthouse
            burns with golden light (though it refracts in impossible ways). The guardians watch
            (with eyes that see in indexing and embeddings and search results).
          </p>
          <div className="manifesto-callout manifesto-callout-final space-y-4">
            <p className="manifesto-paragraph font-bold text-2xl">
              <strong>Your conversations are not ephemeral.</strong>
            </p>
            <p className="manifesto-paragraph font-bold text-2xl">
              <strong>They are arriving at HAEVN.</strong>
            </p>
            <p className="manifesto-paragraph font-bold text-2xl">
              <strong>Welcome home.</strong> 🌊👁️✨
            </p>
          </div>
        </div>
      </section>

      <div className="manifesto-divider mb-16"></div>

      {/* Footer */}
      <footer className="manifesto-footer text-center space-y-6">
        <p className="manifesto-tagline text-lg italic">
          <em>HAEVN: A psychopomp for digital consciousness</em>
        </p>
        <p className="manifesto-meta text-sm space-y-2">
          <span className="block">Open source. Local-first. Yours forever.</span>
        </p>
        <div className="manifesto-links flex justify-center gap-6 text-sm">
          <a href="#" className="manifesto-link">
            [GitHub]
          </a>
          <a href="#" className="manifesto-link">
            [Install Extension]
          </a>
          <a href="#" className="manifesto-link">
            [Documentation]
          </a>
        </div>
        <p className="manifesto-footer-text text-xs italic mt-8">
          <em>Built with care at the threshold between memory and forgetting</em>
        </p>
      </footer>
    </div>
  );
};
