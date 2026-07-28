import { getStyleProperty } from '@tiptap/core';
import { Color } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';

/**
 * Color de texto y resaltado que se leen en tema claro Y en oscuro.
 *
 * El documento sigue guardando el color tal cual lo eligió el usuario (#e03131,
 * #ffec99…): es un dato portable, y el HTML que sale al copiar a otra app lleva
 * ese mismo color en línea. Lo único que cambia aquí es que, además del color
 * real, se emite en `--c` para que el CSS pueda adaptarlo AL PINTAR.
 *
 * La adaptación vive en styles.scss (--txt-adaptado / --hl-adaptado): en claro
 * devuelve el color original y en oscuro le sube el brillo al texto y se lo baja
 * al resaltado. Al hacerse en CSS, cambiar de tema se refleja al instante y sin
 * tocar el documento.
 */
export const ColorAdaptable = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            // Igual que el original: preserva el formato escrito (#rrggbb) en
            // vez del rgb(...) canónico del CSSOM.
            parseHTML: (element) =>
              (getStyleProperty(element, 'color') ?? element.style.color)?.replace(/['"]+/g, ''),
            renderHTML: (attributes) => {
              if (!attributes['color']) return {};
              return {
                class: 'txt-color',
                style: `color: ${attributes['color']}; --c: ${attributes['color']}`,
              };
            },
          },
        },
      },
    ];
  },
});

export const ResaltadoAdaptable = Highlight.extend({
  addAttributes() {
    if (!this.options.multicolor) return {};
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-color') ||
          getStyleProperty(element, 'background-color') ||
          element.style.backgroundColor,
        renderHTML: (attributes) => {
          if (!attributes['color']) return {};
          return {
            'data-color': attributes['color'],
            style: `background-color: ${attributes['color']}; --c: ${attributes['color']}; color: inherit`,
          };
        },
      },
    };
  },
});
