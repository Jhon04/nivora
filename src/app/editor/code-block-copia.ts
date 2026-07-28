import CodeBlock from '@tiptap/extension-code-block';

/** Copia texto al portapapeles, con fallback para el webview. */
async function copiarTexto(texto: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/**
 * Bloque de código con un botón "Copiar" en la esquina (NodeView). El botón
 * vive fuera del contenido editable; al pulsarlo copia el texto del bloque y
 * muestra "¡Copiado!" un instante.
 */
export const CodeBlockCopia = CodeBlock.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'code-block';

      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'code-copy';
      boton.title = 'Copiar código';
      boton.contentEditable = 'false';
      const icono = document.createElement('span');
      icono.className = 'material-icons';
      icono.textContent = 'content_copy';
      const texto = document.createElement('span');
      texto.className = 'code-copy-txt';
      texto.textContent = 'Copiar';
      boton.append(icono, texto);
      // No robar la selección/foco del editor al pulsar el botón.
      boton.addEventListener('mousedown', (e) => e.preventDefault());

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const lang = node.attrs['language'];
      if (lang) code.setAttribute('data-language', lang);
      pre.appendChild(code);

      boton.addEventListener('click', () => {
        void copiarTexto(code.textContent ?? '').then(() => {
          icono.textContent = 'check';
          texto.textContent = '¡Copiado!';
          boton.classList.add('ok');
          window.setTimeout(() => {
            icono.textContent = 'content_copy';
            texto.textContent = 'Copiar';
            boton.classList.remove('ok');
          }, 1500);
        });
      });

      dom.append(boton, pre);

      return {
        dom,
        contentDOM: code,
        // Ignorar mutaciones ajenas al contenido (p.ej. el texto del botón).
        ignoreMutation: (mutation) => !code.contains(mutation.target as Node),
        update: (nuevo) => {
          if (nuevo.type !== node.type) return false;
          const l = nuevo.attrs['language'];
          if (l) code.setAttribute('data-language', l);
          else code.removeAttribute('data-language');
          return true;
        },
      };
    };
  },
});
