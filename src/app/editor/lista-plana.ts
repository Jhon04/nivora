import { Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { canSplit } from '@tiptap/pm/transform';

/**
 * Listas planas, al estilo Notion.
 *
 * En vez del esquema anidado de ProseMirror (bulletList → listItem → paragraph),
 * cada línea de lista es un bloque INDEPENDIENTE, hermano de los párrafos que
 * tenga alrededor. El tipo y la sangría son atributos, no estructura:
 *
 *   bloqueLista { tipo: 'vinetas'|'numerada'|'tarea', nivel: 0..5, marcada }
 *
 * Lo que se ve como "una lista" es solo el CSS agrupando bloques consecutivos, y
 * la numeración la componen contadores CSS.
 *
 * El motivo del cambio es que con el esquema anidado había DOS objetivos bajo el
 * mismo cursor (el ítem y la lista que lo contiene), y eso hacía inmanejable el
 * arrastre de bloques. Aquí no existe "la lista entera": para mover varias
 * líneas se seleccionan varias.
 */

export type TipoLista = 'vinetas' | 'numerada' | 'tarea';

export const NIVEL_MAX = 5;

/** ¿Es una línea de lista? */
export function esBloqueLista(node: PMNode | null | undefined): boolean {
  return node?.type.name === 'bloqueLista';
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    listaPlana: {
      /** Convierte los bloques de la selección en lista del tipo dado (o los
       *  devuelve a párrafo si ya lo eran). */
      alternarLista: (tipo: TipoLista) => ReturnType;
      /** Suma `delta` a la sangría de las líneas de lista seleccionadas. */
      cambiarNivel: (delta: number) => ReturnType;
    };
  }
}

/** Tipo de lista deducido de un <li> pegado desde fuera. */
function tipoDeLi(el: HTMLElement): TipoLista {
  if (el.querySelector(':scope > input[type=checkbox]') || el.hasAttribute('data-checked')) {
    return 'tarea';
  }
  return el.closest('ol') ? 'numerada' : 'vinetas';
}

/** Sangría de un <li> pegado: cuántas listas lo envuelven. */
function nivelDeLi(el: HTMLElement): number {
  let nivel = -1;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.tagName === 'UL' || n.tagName === 'OL') nivel++;
  }
  return Math.max(0, Math.min(NIVEL_MAX, nivel));
}

export const BloqueLista = Node.create({
  name: 'bloqueLista',
  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      tipo: {
        default: 'vinetas' as TipoLista,
        parseHTML: (el) => (el.getAttribute('data-tipo') as TipoLista) ?? tipoDeLi(el),
        renderHTML: (attrs) => ({ 'data-tipo': attrs['tipo'] }),
      },
      nivel: {
        default: 0,
        parseHTML: (el) =>
          el.hasAttribute('data-nivel') ? Number(el.getAttribute('data-nivel')) : nivelDeLi(el),
        renderHTML: (attrs) => ({ 'data-nivel': attrs['nivel'] }),
      },
      marcada: {
        default: false,
        parseHTML: (el) =>
          el.getAttribute('data-marcada') === 'true' || el.getAttribute('data-checked') === 'true',
        renderHTML: (attrs) => (attrs['marcada'] ? { 'data-marcada': 'true' } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-tipo]' },
      /* Un <li> pegado de fuera se aplana: como este nodo solo admite contenido
         en línea, las sublistas se cierran y caen como bloques hermanos con más
         nivel, que es justo lo que queremos. */
      { tag: 'li' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'bl' }), 0];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let actual = node;
      const dom = document.createElement('div');
      const contenido = document.createElement('span');
      contenido.className = 'bl-txt';

      let casilla: HTMLInputElement | null = null;
      const pintar = (n: PMNode): void => {
        dom.className = 'bl';
        dom.setAttribute('data-tipo', n.attrs['tipo']);
        dom.setAttribute('data-nivel', String(n.attrs['nivel']));
        if (n.attrs['marcada']) dom.setAttribute('data-marcada', 'true');
        else dom.removeAttribute('data-marcada');
        if (casilla) casilla.checked = !!n.attrs['marcada'];
      };

      if (node.attrs['tipo'] === 'tarea') {
        const etiqueta = document.createElement('label');
        etiqueta.contentEditable = 'false';
        etiqueta.className = 'bl-casilla';
        casilla = document.createElement('input');
        casilla.type = 'checkbox';
        casilla.addEventListener('change', () => {
          const pos = getPos();
          if (pos == null) return;
          const tr = editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...actual.attrs,
            marcada: casilla?.checked ?? false,
          });
          editor.view.dispatch(tr);
        });
        etiqueta.appendChild(casilla);
        dom.appendChild(etiqueta);
      }
      dom.appendChild(contenido);
      pintar(node);

      return {
        dom,
        contentDOM: contenido,
        update(nuevo) {
          if (nuevo.type !== actual.type) return false;
          // Cambiar a/desde tarea cambia el DOM: que lo recree ProseMirror.
          if ((nuevo.attrs['tipo'] === 'tarea') !== (actual.attrs['tipo'] === 'tarea')) return false;
          actual = nuevo;
          pintar(nuevo);
          return true;
        },
        // Los clics en la casilla los gestionamos nosotros.
        stopEvent: (e) => !!casilla && e.target === casilla,
      };
    };
  },

  addCommands() {
    return {
      alternarLista:
        (tipo) =>
        ({ state, tr, dispatch }) => {
          const bloques = bloquesDe(state);
          if (!bloques.length) return false;

          const parrafo = state.schema.nodes['paragraph'];
          const quitar = bloques.every(
            (b) => b.node.type === this.type && b.node.attrs['tipo'] === tipo,
          );

          if (dispatch) {
            for (const b of bloques) {
              const pos = tr.mapping.map(b.pos);
              const destino = quitar ? parrafo : this.type;
              const $p = tr.doc.resolve(pos);
              const idx = $p.index();
              if (!$p.parent.canReplaceWith(idx, idx + 1, destino)) continue;
              tr.setNodeMarkup(
                pos,
                destino,
                quitar ? {} : { tipo, nivel: b.node.attrs['nivel'] ?? 0, marcada: false },
              );
            }
          }
          return true;
        },

      cambiarNivel:
        (delta) =>
        ({ state, tr, dispatch }) => {
          const bloques = bloquesDe(state).filter((b) => b.node.type === this.type);
          if (!bloques.length) return false;

          let algo = false;
          for (const b of bloques) {
            const nivel = nivelValido(state.doc, b.pos, b.node.attrs['nivel'] + delta);
            if (nivel === b.node.attrs['nivel']) continue;
            algo = true;
            if (dispatch) {
              tr.setNodeMarkup(tr.mapping.map(b.pos), undefined, { ...b.node.attrs, nivel });
            }
          }
          return algo;
        },
    };
  },

  addKeyboardShortcuts() {
    const enLista = (): boolean =>
      this.editor.state.selection.$from.parent.type === this.type;

    return {
      /* Dentro de una lista el Tab SIEMPRE se consume, aunque la sangría no
         pueda cambiar (primera línea, o ya al máximo). Si se devolviera false,
         el navegador haría lo suyo y el foco saltaría fuera del editor, al
         siguiente botón. */
      Tab: () => {
        if (!enLista()) return false;
        this.editor.commands.cambiarNivel(1);
        return true;
      },
      'Shift-Tab': () => {
        if (!enLista()) return false;
        this.editor.commands.cambiarNivel(-1);
        return true;
      },

      Enter: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || $from.parent.type !== this.type) return false;

        /* Línea vacía: primero se saca de la sangría; ya al ras, deja de ser
           lista. Los comandos se piden por `props` y no por `this.editor`:
           así comparten la transacción de `first`. Si cada uno despachara la
           suya, la de `first` se aplicaría sobre un estado ya cambiado
           ("Applying a mismatched transaction"). */
        if ($from.parent.content.size === 0) {
          return this.editor.commands.first(({ commands }) => [
            () => commands.cambiarNivel(-1),
            () => commands.setNode('paragraph'),
          ]);
        }

        /* El split se hace a mano, indicando el tipo del bloque nuevo. Con
           splitBlock() de ProseMirror, al partir AL FINAL de la línea el nodo
           nuevo se crea con el tipo por defecto del esquema (un párrafo), y la
           lista se cortaba en cuanto pulsabas Enter. */
        return this.editor.commands.command(({ tr, state: s, dispatch }) => {
          const pos = s.selection.$from.pos;
          // La línea nueva hereda tipo y nivel, pero nunca el "hecho".
          const tipos = [{ type: this.type, attrs: { ...s.selection.$from.parent.attrs, marcada: false } }];
          if (!canSplit(tr.doc, pos, 1, tipos)) return false;
          if (dispatch) tr.split(pos, 1, tipos).scrollIntoView();
          return true;
        });
      },

      Backspace: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!empty || $from.parent.type !== this.type || $from.parentOffset !== 0) return false;
        return $from.parent.attrs['nivel'] > 0
          ? this.editor.commands.cambiarNivel(-1)
          : this.editor.commands.setNode('paragraph');
      },

      'Mod-Shift-8': () => this.editor.commands.alternarLista('vinetas'),
      'Mod-Shift-7': () => this.editor.commands.alternarLista('numerada'),
      'Mod-Shift-9': () => this.editor.commands.alternarLista('tarea'),
    };
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^\s*([-+*])\s$/,
        type: this.type,
        getAttributes: () => ({ tipo: 'vinetas' }),
      }),
      textblockTypeInputRule({
        find: /^\s*(\d+)\.\s$/,
        type: this.type,
        getAttributes: () => ({ tipo: 'numerada' }),
      }),
      textblockTypeInputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        type: this.type,
        getAttributes: (m) => ({ tipo: 'tarea', marcada: m[1]?.toLowerCase() === 'x' }),
      }),
    ];
  },
});

/** Bloques de texto tocados por la selección. */
function bloquesDe(state: {
  selection: { from: number; to: number };
  doc: PMNode;
}): { pos: number; node: PMNode }[] {
  const bloques: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (node.isTextblock && node.type.name !== 'codeBlock') bloques.push({ pos, node });
  });
  return bloques;
}

/**
 * Recorta un nivel a lo que permite el bloque anterior: no se puede saltar más
 * de un escalón de golpe, igual que con el Tab de una lista normal.
 */
function nivelValido(doc: PMNode, pos: number, deseado: number): number {
  const $p = doc.resolve(pos);
  const anterior = $p.nodeBefore;
  const tope = esBloqueLista(anterior) ? (anterior?.attrs['nivel'] ?? 0) + 1 : 0;
  return Math.max(0, Math.min(Math.min(deseado, tope), NIVEL_MAX));
}
