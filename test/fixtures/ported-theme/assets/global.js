class ModalDialog extends HTMLElement {
  connectedCallback() {
    document.body.appendChild(this);
  }
}
customElements.define('modal-dialog', ModalDialog);
