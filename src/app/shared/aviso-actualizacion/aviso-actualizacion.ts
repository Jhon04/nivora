import { Component, computed, inject, output } from '@angular/core';

import { ActualizacionesService } from '../../core/actualizaciones.service';

/**
 * Banda que avisa de que hay una versión nueva, y su progreso mientras se
 * instala.
 *
 * Lo lee todo del servicio, que es quien lleva el estado de la actualización.
 * Lo único que sale fuera es **instalar**: antes de reiniciar hay que vaciar el
 * guardado pendiente, y de eso sabe la app, no esta banda.
 */
@Component({
  selector: 'app-aviso-actualizacion',
  standalone: true,
  templateUrl: './aviso-actualizacion.html',
  styleUrl: './aviso-actualizacion.scss',
  host: {
    /* El host desaparece y la banda queda como hija directa de la columna del
       panel, igual que cuando el marcado vivía en la plantilla de la app. Si no,
       el margen de la banda quedaría encerrado en una caja intermedia. */
    style: 'display: contents',
  },
})
export class AvisoActualizacion {
  protected readonly actualizaciones = inject(ActualizacionesService);

  /** Pulsaron «Actualizar». Instalar y reiniciar lo hace la app. */
  readonly actualizar = output<void>();

  /** Sin novedad y buscando en segundo plano no se enseña nada. */
  protected readonly visible = computed(() => {
    const estado = this.actualizaciones.estado();
    return estado !== 'inactivo' && estado !== 'buscando';
  });

  /** Mientras baja o va a reiniciar, descartar no llevaría a ninguna parte. */
  protected readonly sePuedeDescartar = computed(() => {
    const estado = this.actualizaciones.estado();
    return estado !== 'descargando' && estado !== 'lista';
  });
}
