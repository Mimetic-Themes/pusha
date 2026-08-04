class ProductCarousel extends HTMLElement {
  connectedCallback() {
    this.observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => e.target.classList.toggle('in-view', e.isIntersecting));
    });
    this.querySelectorAll('img').forEach((img) => this.observer.observe(img));
  }
}
customElements.define('product-carousel', ProductCarousel);
