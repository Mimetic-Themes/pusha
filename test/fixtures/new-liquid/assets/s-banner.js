class SBanner extends HTMLElement {
  connectedCallback() {
    this.hidden = false;
  }
  disconnectedCallback() {}
}
customElements.define('s-banner', SBanner);
