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

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) entry.target.classList.add("active");
  }
}, { threshold: 0.12 });

for (const section of document.querySelectorAll(".reveal-section")) {
  observer.observe(section);
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") ?? "";
    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1400);
    } catch {
      button.textContent = "Copy failed";
    }
  });
}
