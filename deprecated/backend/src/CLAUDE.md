# Dependency injection

All files must follow NestJS DI best practices, all functions must be inside of a NestJS DI Container.

orders/
order.module.ts
order.service.ts
order.controller.ts
order-notifier.service.ts
order-exporter.service.ts

the only things inside of each file is a class wrapped with functions, and for another module to use it, they have to go through the import: []. Loose functions exported in a file is bad practice, barrel index re-exporting is also bad.

> nestjs-best-practices skill is your best friend

# Naming Convension

file names should be kebab-case, e.g. `order.service.ts`, AND classes should match the file name, e.g. `OrderService`.

Whenever naming constructor parameters, name the parameter the same as the type. E.g.

```ts
constructor(private readonly orderService: OrderService) {
}
```

NOT

```ts
constructor(private readonly orders: OrderService) {
}
```
