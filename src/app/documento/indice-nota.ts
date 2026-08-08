import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { normalizar } from '../core/texto';
import { EntradaIndice } from '../editor/indice';

/** Una entrada con el puesto que ocupa en el índice completo (ver `visibles`). */
interface EntradaVisible {
  entrada: EntradaIndice;
  i: number;
}

/**
 * Panel con los títulos de la nota, para moverse por una nota larga como por el
 * índice de una tesis.
 *
 * Es solo presentación: los títulos los saca del documento el editor (ver
 * `editor/indice.ts`), que es también quien sabe saltar hasta uno. Aquí no se
 * guarda nada.
 */
@Component({
  selector: 'app-indice-nota',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './indice-nota.html',
  styleUrl: './indice-nota.scss',
})
export class IndiceNota {
  readonly entradas = input.required<EntradaIndice[]>();
  /** Cuál se resalta, por su orden en el índice completo. */
  readonly activo = input(0);

  /** Puesto en el índice completo de la entrada pulsada. */
  readonly irA = output<number>();
  readonly cerrar = output<void>();

  protected readonly filtro = signal('');

  /**
   * Entradas que se pintan, con su puesto **en el índice completo**.
   *
   * Ese puesto es el que viaja en `irA` y con el que se compara `activo`: si se
   * usara la posición dentro de la lista filtrada, al buscar se saltaría a la
   * sección equivocada.
   */
  protected readonly visibles = computed<EntradaVisible[]>(() => {
    const todas = this.entradas().map((entrada, i) => ({ entrada, i }));
    const q = normalizar(this.filtro());
    return q ? todas.filter((v) => normalizar(v.entrada.texto).includes(q)) : todas;
  });
}
