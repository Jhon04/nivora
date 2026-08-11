import { ConnectedPosition } from '@angular/cdk/overlay';

/**
 * Dónde cae un desplegable respecto al botón que lo abre (CDK Overlay):
 * debajo y, si no cabe, encima; alineado por la izquierda y, si se sale, por la
 * derecha. El CDK prueba en este orden y se queda con la primera que entre en
 * pantalla.
 *
 * Está aquí y no en cada componente para que todos los menús de la app caigan
 * igual: la barra de herramientas, los de tabla del editor y el selector de
 * bóvedas tenían tres copias idénticas de esta lista.
 *
 * Las usa quien las pinta a través de un campo del componente: una plantilla de
 * Angular no puede leer una constante de módulo directamente.
 */
export const POSICIONES_MENU: ConnectedPosition[] = [
  { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
  { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
  { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
  { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
];
