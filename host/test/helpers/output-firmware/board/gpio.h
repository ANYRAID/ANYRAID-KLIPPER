#ifndef TEST_GPIO_H
#define TEST_GPIO_H
#include <stdint.h>
struct gpio_out { uint8_t pin; };
struct gpio_pwm { uint8_t pin; };
extern uint32_t test_pins[256];
static inline struct gpio_out gpio_out_setup(uint8_t pin, uint8_t value) {
        test_pins[pin] = !!value; return (struct gpio_out){pin}; }
static inline void gpio_out_write(struct gpio_out pin, uint8_t value) {
        test_pins[pin.pin] = !!value; }
static inline void gpio_out_toggle_noirq(struct gpio_out pin) {
        test_pins[pin.pin] ^= 1; }
static inline struct gpio_pwm gpio_pwm_setup(uint8_t pin, uint32_t cycle,
        uint16_t value) { (void)cycle; test_pins[pin] = value; return (struct
        gpio_pwm){pin}; }
static inline void gpio_pwm_write(struct gpio_pwm pin, uint16_t value) {
        test_pins[pin.pin] = value; }
#endif
