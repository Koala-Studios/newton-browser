const count = () => document.querySelector("#count");
const inputEvents = [];

if (!document.cookie.includes("bb_auth_fixture=")) document.cookie = "bb_auth_fixture=preserved; SameSite=Lax; path=/";
if (!localStorage.getItem("bb_auth_fixture")) localStorage.setItem("bb_auth_fixture", "preserved");
if (!sessionStorage.getItem("bb_auth_fixture")) sessionStorage.setItem("bb_auth_fixture", "preserved");
document.querySelector("#auth-persistence").value = [
  document.cookie.includes("bb_auth_fixture=preserved") ? "cookie:preserved" : "cookie:missing",
  `local:${localStorage.getItem("bb_auth_fixture") ?? "missing"}`,
  `session:${sessionStorage.getItem("bb_auth_fixture") ?? "missing"}`,
].join("|");

for (const type of ["mousemove", "mousedown", "mouseup", "click"]) {
  document.addEventListener(type, (event) => {
    inputEvents.push(`${type}:${event.target?.id || event.target?.tagName || "unknown"}:${Math.round(event.clientX)},${Math.round(event.clientY)}`);
    document.querySelector("#event-log").value = inputEvents.slice(-8).join("|");
  }, true);
}

customElements.define("fixture-shadow", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="shadow-button">Shadow button</button><input aria-label="Shadow input">';
  }
});

customElements.define("fixture-shadow-child", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="nested-shadow-button">Nested shadow button</button>';
  }
});

customElements.define("fixture-nested-shadow", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<fixture-shadow-child></fixture-shadow-child>';
  }
});

document.querySelector("#cross-frame").src = `http://127.0.0.1:${Number(location.port) + 1}/cross-origin.html`;
document.querySelector("#increment").addEventListener("click", () => { count().textContent = String(Number(count().textContent) + 1); });
document.querySelector("#moving-target").addEventListener("mousemove", (event) => {
  event.currentTarget.style.transform = "translateX(240px)";
}, { once: true });
document.querySelector("#rerender").addEventListener("click", () => {
  document.querySelector("#spa-slot").innerHTML = '<button id="fresh-target">Fresh target</button>';
});
document.querySelector("#custom-combobox").addEventListener("click", (event) => {
  event.currentTarget.textContent = "Canada";
  event.currentTarget.setAttribute("aria-expanded", "true");
});
document.querySelector("#canada-option").addEventListener("click", (event) => {
  event.currentTarget.setAttribute("aria-selected", "true");
  document.querySelector("#selected-option").textContent = "Canada option selected";
});
document.querySelector("#run-search").addEventListener("click", () => {
  document.querySelector("#search-result").textContent = `search-result:${document.querySelector("#search-records").value}`;
});
document.querySelector("#dialog-alert").addEventListener("click", () => alert("fixture-alert"));
document.querySelector("#dialog-confirm").addEventListener("click", () => confirm("fixture-confirm"));
document.querySelector("#dialog-prompt").addEventListener("click", () => prompt("fixture-prompt", "fixture-default"));
document.querySelector("#popup").addEventListener("click", () => window.open("/second.html", "_blank", "noopener"));
document.querySelector("#network-write").addEventListener("click", () => fetch("/write", { method: "POST", body: "fixture=1" }));
document.querySelector("#save-draft").addEventListener("click", () => { document.querySelector("#ready").textContent = "draft-saved"; });
for (const id of ["place-order", "delete-record", "like-fixture", "subscribe-fixture"]) {
  document.querySelector(`#${id}`).addEventListener("click", () => { document.querySelector("#commit-log").textContent = id; });
}
for (const field of document.querySelectorAll("#password,#otp,#card,#ssn,#iban")) {
  for (const type of ["keydown", "keypress", "input"]) {
    field.addEventListener(type, (event) => {
      document.querySelector("#sensitive-key-log").value = `${type}:${event.target.id}`;
    });
  }
}
for (const input of document.querySelectorAll('input[type="file"]')) {
  input.addEventListener("change", () => {
    document.querySelector("#accepted-files").textContent = [...input.files].map((file) => `${file.name}:${file.size}:${file.type}`).join("|") || "none";
  });
}
document.querySelector("#publish-form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.querySelector("#commit-log").textContent = "publish-form";
  document.querySelector("#submit-count").textContent = String(Number(document.querySelector("#submit-count").textContent) + 1);
});

new IntersectionObserver(([entry]) => {
  if (entry?.isIntersecting) entry.target.textContent = `${entry.target.textContent} lazy-loaded`;
}).observe(document.querySelector("#lazy-region"));
