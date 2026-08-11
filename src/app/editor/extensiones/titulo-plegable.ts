import { Heading } from '@tiptap/extension-heading';
import { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, Plugin, PluginKey, TextSelection, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Títulos que se pliegan, al estilo de los «toggle heading» de Notion.
 *
 * **La nota NO cambia de forma.** En Notion un toggle heading se lleva sus
 * bloques dentro y el documento pasa a estar anidado; aquí los títulos y lo que
 * cuelga de ellos siguen siendo hermanos, igual que antes. Plegar es solo una
 * manera de mirar: se ocultan los bloques que van detrás del título hasta el
 * siguiente del mismo nivel o de uno más alto.
 *
 * Se hace así por dos razones:
 *  - El fichero guardado no cambia de estructura. Una nota escrita antes de
 *    esto se abre plegable sin migrar nada, y una plegada se lee igual desde
 *    fuera de la app.
 *  - Es la misma decisión que ya se tomó con las listas (ver `lista-plana.ts`):
 *    bloques planos, la jerarquía se deduce.
 *
 * Lo único que se guarda en el documento es un `plegado` por título, para que
 * al volver a abrir la nota siga como la dejaste.
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tituloPlegable: {
      /** Pliega o despliega el título que hay en `pos`. */
      alternarPlegado: (pos: number) => ReturnType;
      /** Despliega todos los títulos que estén escondiendo `pos`. */
      desplegarHasta: (pos: number) => ReturnType;
    };
  }
}

/** Un hijo directo del documento, con su posición. */
interface Bloque {
  nodo: PMNode;
  pos: number;
}

const clavePlegado = new PluginKey('tituloPlegable');

/** Clase de los bloques que un título plegado está escondiendo. */
export const CLASE_OCULTO = 'plegado-oculto';

function bloques(doc: PMNode): Bloque[] {
  const lista: Bloque[] = [];
  doc.forEach((nodo, pos) => lista.push({ nodo, pos }));
  return lista;
}

function esTitulo(nodo: PMNode): boolean {
  return nodo.type.name === 'heading';
}

/**
 * Cuántos bloques cuelgan del título que está en `i`: los de detrás, hasta el
 * siguiente título de su mismo nivel o de uno más alto. Devuelve el índice
 * (exclusivo) donde acaba la sección.
 */
function finDeSeccion(lista: Bloque[], i: number): number {
  const nivel = lista[i].nodo.attrs['level'] as number;
  let j = i + 1;
  while (j < lista.length) {
    const { nodo } = lista[j];
    if (esTitulo(nodo) && (nodo.attrs['level'] as number) <= nivel) break;
    j++;
  }
  return j;
}

/**
 * Decoraciones: esconde lo que cuelga de cada título plegado y pone la flecha
 * en los que tienen algo que esconder.
 *
 * La flecha va como *widget* y no como un NodeView del título: un NodeView
 * obligaría a rehacer el elemento entero cada vez que cambia de nivel (que es
 * lo que hace el desplegable «H» de la barra), y esto solo necesita colgar un
 * botón del principio.
 */
function decoraciones(state: EditorState): DecorationSet {
  const lista = bloques(state.doc);
  const decs: Decoration[] = [];

  for (let i = 0; i < lista.length; i++) {
    const { nodo, pos } = lista[i];
    if (!esTitulo(nodo)) continue;

    const fin = finDeSeccion(lista, i);
    // Un título sin nada detrás no se puede plegar: tampoco enseña la flecha.
    if (fin === i + 1) continue;

    const plegado = nodo.attrs['plegado'] === true;
    decs.push(
      Decoration.widget(pos + 1, () => flecha(plegado), {
        side: -1,
        // Los clics los atiende el propio botón; ProseMirror no tiene que
        // interpretarlos como una posición del documento.
        stopEvent: () => true,
        ignoreSelection: true,
        // Sin esto, dos títulos seguidos con el mismo estado comparten widget y
        // la flecha no se repinta al plegar uno de ellos.
        key: `flecha-${pos}-${plegado}`,
      }),
    );

    if (!plegado) continue;
    for (let j = i + 1; j < fin; j++) {
      const b = lista[j];
      decs.push(
        Decoration.node(b.pos, b.pos + b.nodo.nodeSize, { class: CLASE_OCULTO }),
      );
    }
  }

  return DecorationSet.create(state.doc, decs);
}

function flecha(plegado: boolean): HTMLElement {
  const boton = document.createElement('button');
  boton.type = 'button';
  boton.className = 'plegar-caret';
  boton.contentEditable = 'false';
  boton.dataset['plegado'] = String(plegado);
  boton.title = plegado ? 'Desplegar la sección' : 'Plegar la sección';
  boton.setAttribute('aria-label', boton.title);

  /* El glifo va en un <span> aparte y no en el propio botón: `.plegar-caret`
     usa `all: unset` para quitarle la pinta de botón, y eso incluye la
     `font-family`, así que el icono se quedaba en su nombre en texto plano. Es
     el mismo reparto que hacen los botones de la barra de herramientas. */
  const icono = document.createElement('span');
  icono.className = 'material-icons';
  icono.textContent = plegado ? 'chevron_right' : 'expand_more';
  boton.appendChild(icono);

  // Al pulsar no se mueve el cursor: el foco se queda donde estaba.
  boton.addEventListener('mousedown', (e) => e.preventDefault());
  return boton;
}

/**
 * Pliega o despliega el título de `pos`.
 *
 * Al plegar, si el cursor estaba dentro de lo que se esconde hay que sacarlo:
 * un cursor dentro de un bloque con `display:none` deja de verse y el teclado
 * seguiría escribiendo ahí, a ciegas.
 */
function alternar(state: EditorState, tr: Transaction, pos: number): boolean {
  const nodo = state.doc.nodeAt(pos);
  if (!nodo || !esTitulo(nodo)) return false;

  const plegado = nodo.attrs['plegado'] === true;
  tr.setNodeMarkup(pos, undefined, { ...nodo.attrs, plegado: !plegado });

  if (!plegado) {
    const lista = bloques(state.doc);
    const i = lista.findIndex((b) => b.pos === pos);
    const fin = finDeSeccion(lista, i);
    const desde = pos + nodo.nodeSize;
    const hasta = i + 1 < fin ? lista[fin - 1].pos + lista[fin - 1].nodo.nodeSize : desde;
    const cursor = state.selection.from;
    if (cursor >= desde && cursor <= hasta) {
      tr.setSelection(TextSelection.create(tr.doc, pos + nodo.content.size + 1));
    }
  }
  return true;
}

export const TituloPlegable = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      plegado: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-plegado') === 'true',
        // Solo se escribe cuando está plegado: así el documento de una nota que
        // nadie ha plegado queda exactamente igual que antes de existir esto.
        renderHTML: (attrs) => (attrs['plegado'] ? { 'data-plegado': 'true' } : {}),
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),

      alternarPlegado:
        (pos: number) =>
        ({ state, tr, dispatch }) => {
          if (!alternar(state, tr, pos)) return false;
          if (dispatch) dispatch(tr);
          return true;
        },

      desplegarHasta:
        (pos: number) =>
        ({ state, tr, dispatch }) => {
          const lista = bloques(state.doc);
          let algo = false;
          for (let i = 0; i < lista.length; i++) {
            const { nodo, pos: p } = lista[i];
            if (!esTitulo(nodo) || nodo.attrs['plegado'] !== true) continue;
            const fin = finDeSeccion(lista, i);
            const hasta = lista[fin - 1].pos + lista[fin - 1].nodo.nodeSize;
            if (pos > p && pos < hasta) {
              tr.setNodeMarkup(p, undefined, { ...nodo.attrs, plegado: false });
              algo = true;
            }
          }
          if (algo && dispatch) dispatch(tr);
          return algo;
        },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: clavePlegado,
        props: {
          decorations: (state) => decoraciones(state),

          handleDOMEvents: {
            /* El clic se atiende aquí y no en el propio botón: el widget se
               vuelve a crear en cada repintado, así que un listener suyo se
               perdería con él. Desde aquí basta con reconocer el botón. */
            click: (view, event) => {
              const destino = event.target as HTMLElement | null;
              const boton = destino?.closest?.('.plegar-caret');
              if (!boton) return false;
              const titulo = boton.closest('h1, h2, h3, h4');
              if (!titulo) return false;
              const pos = view.posAtDOM(titulo, 0) - 1;
              event.preventDefault();
              editor.commands.alternarPlegado(pos);
              return true;
            },
          },
        },
      }),
    ];
  },
});
