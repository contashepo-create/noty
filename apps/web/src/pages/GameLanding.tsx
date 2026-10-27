import { FormEvent, useRef } from "react";
import { useNavigate } from "react-router-dom";

export default function GameLanding() {
  const navigate = useNavigate();
  const clickState = useRef({ count: 0, lastClick: 0 });

  const handleLogoClick = () => {
    const now = Date.now();
    const state = clickState.current;
    state.count = now - state.lastClick <= 2500 ? state.count + 1 : 1;
    state.lastClick = now;

    if (state.count === 8) {
      state.count = 0;
      state.lastClick = 0;
      navigate("/notes?auth=1");
    }
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const query = String(formData.get("q") || "").trim();
    if (query) {
      window.location.assign(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
    }
  };

  return (
    <main className="search-home">
      <header className="search-header">
        <a href="https://duckduckgo.com/about" className="search-header-link">About</a>
        <a href="https://duckduckgo.com/duckduckgo-help-pages/" className="search-header-link">Help</a>
        <button className="search-apps-button" type="button" aria-label="Apps">⠿</button>
        <a className="search-signin" href="https://duckduckgo.com/" target="_blank" rel="noreferrer">Visit search</a>
      </header>

      <section className="search-center">
        <button className="search-wordmark" type="button" onClick={handleLogoClick} aria-label="Search home">
          <span className="search-brand-icon" aria-hidden="true" />
          <span>Search</span>
        </button>
        <form className="search-form" role="search" onSubmit={handleSearch}>
          <label className="search-input-wrap">
            <span className="search-glass" aria-hidden="true" />
            <input name="q" type="search" aria-label="Search the web" autoComplete="off" />
            <button type="button" className="voice-search" aria-label="Voice search">🎙</button>
          </label>
          <div className="search-buttons">
            <button type="submit">Search</button>
            <button type="button" onClick={() => document.querySelector<HTMLInputElement>('.search-input-wrap input')?.focus()}>Explore</button>
          </div>
        </form>
        <p className="search-language">A little more privacy. A lot more peace of mind.</p>
      </section>

      <footer className="search-footer">
        <div className="search-region">The web, made a little simpler</div>
        <div className="search-footer-links">
          <span>Privacy-focused search</span>
          <div><a href="https://duckduckgo.com/privacy">Privacy</a><a href="https://duckduckgo.com/terms">Terms</a><a href="https://duckduckgo.com/about">Settings</a></div>
        </div>
      </footer>
    </main>
  );
}
