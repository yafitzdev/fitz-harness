function stripNativeTitle(element: Element): void {
  if (element.tagName !== "IFRAME") element.removeAttribute("title");
}

function stripNativeTitles(root: ParentNode): void {
  if (root instanceof Element) stripNativeTitle(root);
  for (const element of root.querySelectorAll("[title]")) stripNativeTitle(element);
}

/**
 * Prevent browser-native hover labels while preserving the app's explicit
 * tooltip components and accessible names. Iframe titles remain because they
 * label embedded documents for assistive technology.
 */
export function suppressNativeTooltips(root: ParentNode = document): MutationObserver {
  stripNativeTitles(root);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        stripNativeTitle(mutation.target as Element);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) stripNativeTitles(node);
      }
    }
  });

  observer.observe(root, {
    attributes: true,
    attributeFilter: ["title"],
    childList: true,
    subtree: true,
  });
  return observer;
}
