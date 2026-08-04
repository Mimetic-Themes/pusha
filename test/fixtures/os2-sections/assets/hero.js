class HeroBanner extends HTMLElement {
  connectedCallback() {
    this._onResize = () => this.layout();
    window.addEventListener('resize', this._onResize);
  }
  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize);
  }
  layout() {}
}
customElements.define('hero-banner', HeroBanner);
