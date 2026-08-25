const glow = document.getElementById("cursorGlow");
if (glow) {
  document.addEventListener("mousemove", (event) => {
    glow.style.left = `${event.clientX}px`;
    glow.style.top = `${event.clientY}px`;
    glow.style.opacity = "1";
  });

  document.addEventListener("mouseleave", () => {
    glow.style.opacity = "0";
  });
}

const revealSections = document.querySelectorAll(".reveal-section");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) entry.target.classList.add("active");
    }
  }, { threshold: 0.12 });

  for (const section of revealSections) observer.observe(section);
} else {
  for (const section of revealSections) section.classList.add("active");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.setAttribute("readonly", "");
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") ?? "";
    const original = button.textContent ?? "Copy";
    const originalLabel = button.getAttribute("aria-label");
    try {
      await copyText(text);
      button.textContent = "Copied";
      button.setAttribute("aria-label", "Command copied");
    } catch {
      button.textContent = "Copy failed";
      button.setAttribute("aria-label", "Copy failed");
    }
    window.setTimeout(() => {
      button.textContent = original;
      if (originalLabel === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", originalLabel);
    }, 1400);
  });
}
