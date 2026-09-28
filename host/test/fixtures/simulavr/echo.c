#include <avr/io.h>
int main(void) {
    UBRR0=3; // 16 MHz, normal UART mode: 250000 baud.
    UCSR0B=(1<<RXEN0)|(1<<TXEN0);
    UCSR0C=(1<<UCSZ01)|(1<<UCSZ00);
    for(;;) {
        while(!(UCSR0A&(1<<RXC0))) {}
        unsigned char c=UDR0;
        while(!(UCSR0A&(1<<UDRE0))) {}
        UDR0=c;
    }
}
