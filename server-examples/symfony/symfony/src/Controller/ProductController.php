<?php

namespace App\Controller;

use App\Entity\Product;
use App\Repository\ProductRepository;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api/products')]
class ProductController extends AbstractController
{
    public function __construct(private readonly ProductRepository $products) {}

    #[Route('', methods: ['GET'])]
    public function index(Request $request): JsonResponse
    {
        $page     = max(1, (int) $request->query->get('page', 1));
        $pageSize = max(1, (int) $request->query->get('pageSize', 10));
        $sort     = $request->query->all('sort');
        $filters  = $request->query->all('filters');

        ['products' => $products, 'total' => $total] = $this->products->findPage($page, $pageSize, $sort, $filters);

        $data = array_map(fn(Product $p) => [
            'id'       => $p->getId(),
            'name'     => $p->getName(),
            'sku'      => $p->getSku(),
            'category' => $p->getCategory(),
            'price'      => (float) $p->getPrice(),
            'stock'      => $p->getStock(),
            'sort_order' => $p->getSortOrder(),
        ], $products);

        return $this->json(['data' => $data, 'total' => $total]);
    }

    #[Route('', methods: ['POST'])]
    public function store(Request $request): JsonResponse
    {
        $payload        = json_decode($request->getContent(), true) ?? [];
        $rowsAmount     = max(1, (int) ($payload['rowsAmount'] ?? 1));
        $position       = $payload['position'] ?? 'below';
        $referenceRowId = isset($payload['referenceRowId']) ? (int) $payload['referenceRowId'] : null;

        $this->products->createBlankRows($rowsAmount, $position, $referenceRowId);

        return $this->json(null, 201);
    }

    #[Route('', methods: ['PATCH'])]
    public function batchUpdate(Request $request): JsonResponse
    {
        $rows = json_decode($request->getContent(), true) ?? [];

        $this->products->updateRows($rows);

        return $this->json(null, 200);
    }

    #[Route('', methods: ['DELETE'])]
    public function batchDestroy(Request $request): JsonResponse
    {
        $ids = json_decode($request->getContent(), true) ?? [];

        $this->products->deleteByIds($ids);

        return $this->json(null, 204);
    }
}
