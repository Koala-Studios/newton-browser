const count = () => document.querySelector("#count");

customElements.define("fixture-shadow", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="shadow-button">Shadow button</button><input aria-label="Shadow input">';
  }
});

document.querySelector("#cross-frame").src = `http://127.0.0.1:${Number(location.port) + 1}/cross-origin.html`;
document.querySelector("#increment").addEventListener("click", () => { count().textContent = String(Number(count().textContent) + 1); });
document.querySelector("#rerender").addEventListener("click", () => {
  document.querySelector("#spa-slot").innerHTML = '<button id="fresh-target">Fresh target</button>';
});
document.querySelector("#custom-combobox").addEventListener("click", (event) => {
  event.currentTarget.textContent = "Canada";
  event.currentTarget.setAttribute("aria-expanded", "true");
});
document.querySelector("#dialog").addEventListener("click", () => alert("fixture-dialog"));
document.querySelector("#popup").addEventListener("click", () => window.open("/second.html", "_blank", "noopener"));
document.querySelector("#network-write").addEventListener("click", () => fetch("/write", { method: "POST", body: "fixture=1" }));
document.querySelector("#save-draft").addEventListener("click", () => { document.querySelector("#ready").textContent = "draft-saved"; });
for (const input of document.querySelectorAll('input[type="file"]')) {
  input.addEventListener("change", () => {
    document.querySelector("#accepted-files").textContent = [...input.files].map((file) => `${file.name}:${file.size}:${file.type}`).join("|") || "none";
  });
}
document.querySelector("#publish-form").addEventListener("submit", () => {
  document.querySelector("#submit-count").textContent = String(Number(document.querySelector("#submit-count").textContent) + 1);
});

new IntersectionObserver(([entry]) => {
  if (entry?.isIntersecting) entry.target.textContent = `${entry.target.textContent} lazy-loaded`;
}).observe(document.querySelector("#lazy-region"));
