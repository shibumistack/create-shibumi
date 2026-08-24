// Admin panel behavior. Self-hosted so it runs under the app's
// script-src 'self' CSP. Confirms destructive form submits using the
// message in each form's data-confirm attribute (safe against apostrophes
// and markup, unlike an inline handler).
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const message = form.dataset.confirm;
  if (message && !window.confirm(message)) {
    event.preventDefault();
  }
});
