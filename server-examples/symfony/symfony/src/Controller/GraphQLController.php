<?php

namespace App\Controller;

use App\GraphQL\ProductSchema;
use App\Repository\ProductRepository;
use GraphQL\Error\DebugFlag;
use GraphQL\GraphQL;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/graphql', methods: ['POST'])]
class GraphQLController extends AbstractController
{
    public function __construct(private readonly ProductRepository $products) {}

    public function __invoke(Request $request): JsonResponse
    {
        $body      = json_decode($request->getContent(), true) ?? [];
        $query     = $body['query']     ?? '';
        $variables = $body['variables'] ?? null;

        $schema = ProductSchema::build($this->products);
        $result = GraphQL::executeQuery($schema, $query, null, null, $variables);

        $debug = $this->getParameter('kernel.debug')
            ? DebugFlag::INCLUDE_DEBUG_MESSAGE | DebugFlag::INCLUDE_TRACE
            : DebugFlag::NONE;

        return $this->json($result->toArray($debug));
    }
}
