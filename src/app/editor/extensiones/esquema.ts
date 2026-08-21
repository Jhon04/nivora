import { Node, mergeAttributes } from '@tiptap/core';

import { dibujar } from '../esquema/dibujo';
import { Esquema, esquemaVacio, normalizar } from '../esquema/modelo';
import { EVENTO_ESQUEMA, EVENTO_EXPORTAR_ESQUEMA } from './slash-command';

/** Detalle del evento con el que un bloque pide abrir el editor. */
export interface PeticionEsquema {
  /** Posición del nodo en el documento, o `null` si se va a crear uno. */
  pos: number | null;
  datos: unknown;
}

/** Detalle del evento con el que un bloque pide guardarse como fichero. */
export interface PeticionExportar {
  datos: unknown;
  formato: 'svg' | 'png';
  /** Se llama con `true` si el fichero llegó a escribirse. */
  hecho?: (bien: boolean) => void;
}

/**
 * Formatos del menú, en el orden en que se ofrecen.
 *
 * SVG primero porque es lo que el diagrama ya es: vectorial, con el texto
 * todavía texto y unos pocos KB. El PNG está porque el SVG no se pega en un
 * correo ni en un chat.
 */
const FORMATOS = [
  { id: 'svg', nombre: 'SVG', pista: 'vectorial, se puede retocar' },
  { id: 'png', nombre: 'PNG', pista: 'para pegar en cualquier sitio' },
] as const;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    esquema: {
      /** Mete un esquema ya dibujado en el documento. */
      insertarEsquema: (datos: Esquema) => ReturnType;
    };
  }
}

/**
 * Bloque **esquema**: un diagrama que se dibuja arrastrando, no escribiendo.
 *
 * Existe aparte de `/diagrama` (Mermaid) y no como un modo suyo porque los dos
 * no pueden compartir formato. Mermaid calcula la colocación con su propio motor
 * y su sintaxis no tiene dónde guardar un x/y, así que un nodo arrastrado
 * volvería a su sitio en el siguiente render. Aquí las posiciones son el dato
 * principal, y por eso el formato es nuestro.
 *
 * `datos` va como **objeto** en `attrs`, no como JSON en una cadena. Los ficheros
 * de las notas se escriben con `serde_json::to_string_pretty`, así que un objeto
 * sale indentado, con un campo por línea, y mover un nodo produce un diff de una
 * línea. Metido en una cadena sería todo un renglón ilegible en cada cambio.
 */
export const BloqueEsquema = Node.create({
  name: 'esquema',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      datos: {
        default: esquemaVacio(),
        parseHTML: (el) => {
          // Al pegar desde fuera el objeto viaja como JSON en el atributo; si
          // viene roto, `normalizar` se encarga y sale un esquema vacío.
          try {
            return JSON.parse(el.getAttribute('data-esquema') ?? '{}');
          } catch {
            return esquemaVacio();
          }
        },
        renderHTML: (attrs) => ({ 'data-esquema': JSON.stringify(attrs['datos'] ?? {}) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-esquema]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes)];
  },

  addCommands() {
    return {
      insertarEsquema:
        (datos) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { datos } }),
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let actual = node;

      const dom = document.createElement('div');
      dom.className = 'bloque-esquema';
      dom.contentEditable = 'false';

      const vista = document.createElement('div');
      vista.className = 'esquema-vista';

      /** Botón redondo de la esquina, con su icono. */
      const accion = (clase: string, icono: string, titulo: string): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = clase;
        b.title = titulo;
        b.setAttribute('aria-label', titulo);
        const glifo = document.createElement('span');
        glifo.className = 'material-icons';
        glifo.textContent = icono;
        b.appendChild(glifo);
        // No robarle la selección al editor al pulsar.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        return b;
      };

      const editar = accion('esquema-editar', 'edit', 'Editar el esquema');
      const exportar = accion('esquema-exportar', 'download', 'Guardar como fichero');

      const acciones = document.createElement('div');
      acciones.className = 'esquema-acciones';
      acciones.append(exportar, editar);

      /* Menú de formatos. Se arma una vez y se enseña u oculta: montarlo y
         desmontarlo en cada clic dejaría al ratón encima de un botón que ya no
         existe y se perdería el `hover` del bloque, que es lo que mantiene los
         iconos a la vista. */
      const menu = document.createElement('div');
      menu.className = 'esquema-formatos';
      menu.hidden = true;

      const cerrarMenu = () => {
        menu.hidden = true;
        exportar.setAttribute('aria-expanded', 'false');
      };
      cerrarMenu();

      for (const f of FORMATOS) {
        const opcion = document.createElement('button');
        opcion.type = 'button';
        opcion.addEventListener('mousedown', (e) => e.preventDefault());
        const nombre = document.createElement('strong');
        nombre.textContent = f.nombre;
        const pista = document.createElement('span');
        pista.textContent = f.pista;
        opcion.append(nombre, pista);
        opcion.addEventListener('click', () => {
          cerrarMenu();
          pedirExportacion(f.id);
        });
        menu.appendChild(opcion);
      }

      exportar.addEventListener('click', () => {
        menu.hidden = !menu.hidden;
        exportar.setAttribute('aria-expanded', String(!menu.hidden));
      });

      /* Un clic en cualquier otro sitio cierra el menú. Va en `document` y no en
         el bloque: pulsar fuera es justo lo que no llega hasta aquí. */
      const alPulsarFuera = (ev: Event) => {
        if (!menu.hidden && !dom.contains(ev.target as globalThis.Node)) cerrarMenu();
      };
      const alTeclear = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cerrarMenu();
      };
      document.addEventListener('pointerdown', alPulsarFuera, true);
      document.addEventListener('keydown', alTeclear);

      dom.append(vista, acciones, menu);

      const pintar = () => {
        const esquema = normalizar(actual.attrs['datos']);
        // Un esquema vacío no tiene nada que exportar: el botón sobra, y dejarlo
        // solo serviría para sacar un fichero en blanco.
        exportar.hidden = !esquema.nodos.length;
        if (exportar.hidden) cerrarMenu();

        if (!esquema.nodos.length) {
          // Un SVG de un esquema vacío sería un rectángulo en blanco: no dice
          // que esté vacío ni que se pueda hacer algo al respecto.
          const aviso = document.createElement('p');
          aviso.className = 'esquema-vacio';
          aviso.textContent = 'Esquema vacío — doble clic para dibujarlo';
          vista.replaceChildren(aviso);
          return;
        }

        vista.replaceChildren(dibujar(esquema));
      };

      /* El icono confirma el resultado en su sitio y vuelve solo. La app no tiene
         avisos flotantes, y montar uno para esto sería mucho aparato; lo que hay
         que saber es si el fichero se escribió, y se mira donde ya se está
         mirando. */
      let volverIcono: ReturnType<typeof setTimeout> | undefined;
      const responder = (bien: boolean) => {
        clearTimeout(volverIcono);
        const glifo = exportar.querySelector('.material-icons')!;
        glifo.textContent = bien ? 'check' : 'error_outline';
        volverIcono = setTimeout(() => (glifo.textContent = 'download'), 1800);
      };

      const pedirExportacion = (formato: 'svg' | 'png') => {
        editor.view.dom.dispatchEvent(
          new CustomEvent<PeticionExportar>(EVENTO_EXPORTAR_ESQUEMA, {
            bubbles: true,
            detail: { datos: actual.attrs['datos'], formato, hecho: responder },
          }),
        );
      };

      const pedirEdicion = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        editor.view.dom.dispatchEvent(
          new CustomEvent<PeticionEsquema>(EVENTO_ESQUEMA, {
            bubbles: true,
            detail: { pos: pos ?? null, datos: actual.attrs['datos'] },
          }),
        );
      };
      editar.addEventListener('click', pedirEdicion);
      dom.addEventListener('dblclick', pedirEdicion);

      pintar();

      return {
        dom,
        // `atom`: lo de dentro lo dibujamos nosotros entero en cada cambio.
        ignoreMutation: () => true,
        // Toda la esquina de acciones, no solo el lápiz: si ProseMirror se
        // quedara los eventos del menú, elegir un formato movería el cursor.
        stopEvent: (e) => {
          const t = e.target as globalThis.Node;
          return acciones.contains(t) || menu.contains(t);
        },
        destroy: () => {
          clearTimeout(volverIcono);
          document.removeEventListener('pointerdown', alPulsarFuera, true);
          document.removeEventListener('keydown', alTeclear);
        },
        update: (nuevo) => {
          if (nuevo.type !== actual.type) return false;
          actual = nuevo;
          pintar();
          return true;
        },
      };
    };
  },
});
