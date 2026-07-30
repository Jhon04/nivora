import { Node, mergeAttributes } from '@tiptap/core';

import { EVENTO_SECRETO } from './slash-command';

/** Detalle del evento: qué nodo se está editando (o ninguno, si es nuevo). */
export interface PeticionSecreto {
  /** Posición del nodo en el documento, o `null` si se va a crear uno. */
  pos: number | null;
  etiqueta: string;
  datos: string;
}

/** Lo que la app necesita resolver un revelado. */
export type Descifrar = (datos: string) => Promise<string>;

/**
 * Bloque **secreto**: guarda un valor cifrado (contraseñas, cadenas de
 * conexión, credenciales) dentro de una nota normal.
 *
 * Es un `atom` a propósito, y esa es la decisión que sostiene todo lo demás: el
 * texto en claro **nunca entra en el documento**. Si el valor fuera texto
 * editable y se cifrara "al guardar", el autoguardado ya lo habría escrito en
 * claro en disco y en un commit — y git no olvida. Aquí el nodo solo tiene el
 * resultado del cifrado, que hace Rust.
 *
 * Como el valor viaja en `attrs` y no en un nodo de texto, el indexador de
 * búsqueda (`db::extraer_texto`, que recoge las claves `text`) no lo ve: el
 * índice FTS nunca contiene el secreto. La etiqueta sí es texto normal, para
 * poder buscarla y saber qué es sin abrirlo.
 */
export const Secreto = Node.create({
  name: 'secreto',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      etiqueta: { default: '' },
      /** Valor cifrado, con su prefijo de versión (`v1.…`). */
      datos: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-secreto]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-secreto': '' })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'bloque-secreto';
      dom.contentEditable = 'false';

      const candado = document.createElement('span');
      candado.className = 'material-icons secreto-icono';
      candado.textContent = 'key';

      const etiqueta = document.createElement('span');
      etiqueta.className = 'secreto-etiqueta';
      etiqueta.textContent = node.attrs['etiqueta'] || 'Secreto';

      const valor = document.createElement('span');
      valor.className = 'secreto-valor';
      // Enmascarado siempre al pintar: abrir una nota no puede destapar
      // credenciales por su cuenta (una captura, alguien detrás, un proyector).
      const OCULTO = '••••••••••••';
      valor.textContent = OCULTO;

      const acciones = document.createElement('span');
      acciones.className = 'secreto-acciones';

      const boton = (icono: string, titulo: string) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = titulo;
        b.contentEditable = 'false';
        const i = document.createElement('span');
        i.className = 'material-icons';
        i.textContent = icono;
        b.appendChild(i);
        // No robarle la selección al editor al pulsar.
        b.addEventListener('mousedown', (e) => e.preventDefault());
        return { b, i };
      };

      const descifrar = (): Promise<string> => {
        const almacen = editor.storage as unknown as Record<string, { descifrar?: Descifrar }>;
        const fn = almacen['secreto']?.descifrar;
        if (!fn) return Promise.reject(new Error('secretos no disponibles'));
        return fn(node.attrs['datos']);
      };

      const avisar = (i: HTMLElement, icono: string, vuelta: string) => {
        i.textContent = icono;
        window.setTimeout(() => (i.textContent = vuelta), 1500);
      };

      // --- revelar ---
      const { b: ojo, i: iconoOjo } = boton('visibility', 'Mostrar');
      let visible = false;
      let temporizador: number | undefined;
      ojo.addEventListener('click', () => {
        if (visible) {
          visible = false;
          valor.textContent = OCULTO;
          iconoOjo.textContent = 'visibility';
          window.clearTimeout(temporizador);
          return;
        }
        void descifrar()
          .then((claro) => {
            visible = true;
            valor.textContent = claro;
            iconoOjo.textContent = 'visibility_off';
            // Se vuelve a tapar solo: lo normal es mirarlo y seguir a lo tuyo.
            temporizador = window.setTimeout(() => {
              visible = false;
              valor.textContent = OCULTO;
              iconoOjo.textContent = 'visibility';
            }, 20000);
          })
          .catch(() => avisar(iconoOjo, 'lock', 'visibility'));
      });

      // --- copiar ---
      const { b: copiar, i: iconoCopiar } = boton('content_copy', 'Copiar');
      copiar.addEventListener('click', () => {
        void descifrar()
          .then(async (claro) => {
            // Copiar sin enseñarlo es el uso habitual: pegar una contraseña.
            await navigator.clipboard.writeText(claro);
            avisar(iconoCopiar, 'check', 'content_copy');
          })
          .catch(() => avisar(iconoCopiar, 'lock', 'content_copy'));
      });

      // --- editar ---
      const { b: editar } = boton('edit', 'Cambiar el valor');
      const pedirEdicion = () => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        editor.view.dom.dispatchEvent(
          new CustomEvent<PeticionSecreto>(EVENTO_SECRETO, {
            bubbles: true,
            detail: {
              pos: pos ?? null,
              etiqueta: node.attrs['etiqueta'] ?? '',
              datos: node.attrs['datos'] ?? '',
            },
          }),
        );
      };
      editar.addEventListener('click', pedirEdicion);
      dom.addEventListener('dblclick', pedirEdicion);

      acciones.append(ojo, copiar, editar);
      dom.append(candado, etiqueta, valor, acciones);
      return {
        dom,
        // `atom`: ProseMirror no gestiona nada dentro, así que se ignoran las
        // mutaciones del DOM propio (revelar, tapar, iconos de aviso).
        ignoreMutation: () => true,
      };
    };
  },
});
