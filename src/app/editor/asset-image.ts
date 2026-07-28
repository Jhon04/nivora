import Image from '@tiptap/extension-image';

import { resolverSrc } from '../core/asset-path';

/**
 * Igual que la imagen de Tiptap, con dos particularidades:
 *  - `src` guarda el NOMBRE RELATIVO del asset original (p.ej. `a1b2….png`) →
 *    workspace portable; se resuelve con `resolverSrc` al pintarlo.
 *  - `preview` guarda el nombre de la miniatura ligera (generada por Rust). En
 *    el DOM se muestra el preview (carga rápida); el original queda en `src`
 *    para abrirlo a tamaño completo (doble clic → lightbox en el editor).
 */
export const AssetImage = Image.extend({
  addAttributes() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = (this.parent?.() ?? {}) as Record<string, any>;
    return {
      ...parent,
      preview: {
        default: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parseHTML: (el: any) => el.getAttribute('data-preview'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes['preview'] ? { 'data-preview': attributes['preview'] } : {},
      },
      src: {
        ...parent['src'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        renderHTML: (attributes: Record<string, any>) => {
          const src: string | null = attributes['src'];
          if (!src) return {};
          // Mostrar el preview si existe; si no, el original.
          return { src: resolverSrc(attributes['preview'] || src) };
        },
      },
    };
  },
});
