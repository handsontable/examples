<?php

namespace App\GraphQL;

use App\Entity\Product;
use App\Repository\ProductRepository;
use GraphQL\Type\Definition\InputObjectType;
use GraphQL\Type\Definition\ObjectType;
use GraphQL\Type\Definition\Type;
use GraphQL\Type\Schema;

class ProductSchema
{
    public static function build(ProductRepository $repository): Schema
    {
        $productType = new ObjectType([
            'name'   => 'Product',
            'fields' => [
                'id'         => Type::nonNull(Type::int()),
                'name'       => Type::nonNull(Type::string()),
                'sku'        => Type::nonNull(Type::string()),
                'category'   => Type::nonNull(Type::string()),
                'price'      => Type::nonNull(Type::float()),
                'stock'      => Type::nonNull(Type::int()),
                'sort_order' => Type::nonNull(Type::int()),
            ],
        ]);

        $productsPageType = new ObjectType([
            'name'   => 'ProductsPage',
            'fields' => [
                'data'  => Type::nonNull(Type::listOf(Type::nonNull($productType))),
                'total' => Type::nonNull(Type::int()),
            ],
        ]);

        $sortInput = new InputObjectType([
            'name'   => 'SortInput',
            'fields' => [
                'prop'  => Type::nonNull(Type::string()),
                'order' => Type::nonNull(Type::string()),
            ],
        ]);

        $filterInput = new InputObjectType([
            'name'   => 'FilterInput',
            'fields' => [
                'prop'      => Type::nonNull(Type::string()),
                'condition' => Type::nonNull(Type::string()),
                'value'     => Type::string(),
                'value2'    => Type::string(),
            ],
        ]);

        $productChangesInput = new InputObjectType([
            'name'   => 'ProductChangesInput',
            'fields' => [
                'name'     => Type::string(),
                'sku'      => Type::string(),
                'category' => Type::string(),
                'price'    => Type::float(),
                'stock'    => Type::int(),
            ],
        ]);

        $productUpdateInput = new InputObjectType([
            'name'   => 'ProductUpdateInput',
            'fields' => [
                'id'      => Type::nonNull(Type::int()),
                'changes' => Type::nonNull($productChangesInput),
            ],
        ]);

        $queryType = new ObjectType([
            'name'   => 'Query',
            'fields' => [
                'products' => [
                    'type' => Type::nonNull($productsPageType),
                    'args' => [
                        'page'     => ['type' => Type::int(),                              'defaultValue' => 1],
                        'pageSize' => ['type' => Type::int(),                              'defaultValue' => 10],
                        'sort'     => ['type' => $sortInput],
                        'filters'  => ['type' => Type::listOf(Type::nonNull($filterInput))],
                    ],
                    'resolve' => function ($root, array $args) use ($repository): array {
                        $page     = max(1, $args['page']     ?? 1);
                        $pageSize = max(1, $args['pageSize'] ?? 10);
                        $sort     = $args['sort']    ?? [];
                        $filters  = $args['filters'] ?? [];

                        ['products' => $products, 'total' => $total] =
                            $repository->findPage($page, $pageSize, $sort, $filters);

                        return [
                            'data'  => array_map(fn(Product $p) => [
                                'id'         => $p->getId(),
                                'name'       => $p->getName(),
                                'sku'        => $p->getSku(),
                                'category'   => $p->getCategory(),
                                'price'      => (float) $p->getPrice(),
                                'stock'      => $p->getStock(),
                                'sort_order' => $p->getSortOrder(),
                            ], $products),
                            'total' => $total,
                        ];
                    },
                ],
            ],
        ]);

        $mutationType = new ObjectType([
            'name'   => 'Mutation',
            'fields' => [
                'createProducts' => [
                    'type' => Type::nonNull(Type::listOf(Type::nonNull($productType))),
                    'args' => [
                        'rowsAmount'     => ['type' => Type::int(),    'defaultValue' => 1],
                        'position'       => ['type' => Type::string(), 'defaultValue' => 'below'],
                        'referenceRowId' => ['type' => Type::int()],
                    ],
                    'resolve' => function ($root, array $args) use ($repository): array {
                        $created = $repository->createBlankRows(
                            max(1, $args['rowsAmount'] ?? 1),
                            $args['position']       ?? 'below',
                            $args['referenceRowId'] ?? null,
                        );

                        return array_map(fn(Product $p) => [
                            'id'         => $p->getId(),
                            'name'       => $p->getName(),
                            'sku'        => $p->getSku(),
                            'category'   => $p->getCategory(),
                            'price'      => (float) $p->getPrice(),
                            'stock'      => $p->getStock(),
                            'sort_order' => $p->getSortOrder(),
                        ], $created);
                    },
                ],
                'updateProducts' => [
                    'type' => Type::nonNull(Type::boolean()),
                    'args' => [
                        'rows' => Type::nonNull(Type::listOf(Type::nonNull($productUpdateInput))),
                    ],
                    'resolve' => function ($root, array $args) use ($repository): bool {
                        $repository->updateRows($args['rows']);
                        return true;
                    },
                ],
                'deleteProducts' => [
                    'type' => Type::nonNull(Type::boolean()),
                    'args' => [
                        'ids' => Type::nonNull(Type::listOf(Type::nonNull(Type::int()))),
                    ],
                    'resolve' => function ($root, array $args) use ($repository): bool {
                        $repository->deleteByIds($args['ids']);
                        return true;
                    },
                ],
            ],
        ]);

        return new Schema(['query' => $queryType, 'mutation' => $mutationType]);
    }
}
